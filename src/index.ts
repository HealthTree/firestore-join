import 'core-js/features/promise'
import firebase from 'firebase'
import _ from 'lodash'
import DocumentReference = firebase.firestore.DocumentReference
import DocumentSnapshot = firebase.firestore.DocumentSnapshot
import QuerySnapshot = firebase.firestore.QuerySnapshot
import Query = firebase.firestore.Query;
import CollectionReference = firebase.firestore.CollectionReference;
import Firestore = firebase.firestore.Firestore;

let cacheTimeout: number = 3000;

let documentReferencePromiseMapCache: { [key: string]: CachedDocumentSnapshotPromise } = {};

let serializedDocumentTransformer: Function = transformDates;

export interface CachedDocumentSnapshotPromise extends Promise<DocumentSnapshot> {
    time: number
}

export interface IncludeConfig {
    [key: string]: Function | Object;
}

export interface JoinRef {
    _type: string;
    path: string;
}

export interface JoinDate {
    _type: string;
    value: string;
}

export interface SerializedDocumentNested {
    [key: string]: SerializedDocument;
}


export class SerializedDocumentPromise extends Promise<SerializedDocument> {
    ready = () => new Promise(async (resolve, reject) => {
        this.then((serializedDocument: SerializedDocument) => {
            serializedDocument.ready().then(resolve).catch(reject)
        }).catch(reject)
    })

    constructor(fn: any) {
        super(fn);
    }
}

export class SerializedDocumentArrayPromise extends Promise<SerializedDocumentArray> {
    ready = () => new Promise(async (resolve, reject) => {
        this.then((serializedDocumentArray: SerializedDocumentArray) => {
            serializedDocumentArray.ready().then(resolve).catch(reject)
        }).catch(reject)
    })

    constructor(fn: any) {
        super(fn);
    }
}

export class SerializedDocumentArray extends Array<SerializedDocument> {
    constructor(querySnapshot: QuerySnapshot, includesConfig: IncludeConfig | 'ALL') {
        let docs: SerializedDocument[] = []
        if (querySnapshot.docs) {
            docs = querySnapshot.docs.map(doc => {
                return new SerializedDocument(doc, includesConfig)
            })
        }
        super(...docs)
    }

    static fromDocumentReferenceArray = (documentReferenceArray: [DocumentReference], includesConfig: IncludeConfig | 'ALL'): SerializedDocumentArrayPromise => {
        return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
            Promise.all(documentReferenceArray.map(documentReference => SerializedDocument.fromDocumentReference(documentReference, includesConfig))).then(serializedDocuments => {
                resolve(Object.setPrototypeOf(serializedDocuments, SerializedDocumentArray.prototype))
            }).catch(reject);
        })
    }

    static fromQuery = (collectionReferenceOrQuery: CollectionReference | Query, includesConfig: IncludeConfig | 'ALL'): SerializedDocumentArrayPromise => {
        return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
            collectionReferenceOrQuery.get().then(querySnapshot => {
                resolve(new SerializedDocumentArray(querySnapshot, includesConfig))
            }).catch(reject);
        });
    }

    static fromJSON = (obj: string, firestore: Firestore): SerializedDocumentArray => fromJSON(obj, firestore)

    allPromises() {
        return Promise.all(this.map(doc => Promise.all(doc._promisesArray)))
    }

    allPromisesRecursive() {
        return Promise.all(this.map(doc => doc.allPromisesRecursive()))
    }

    ready() {
        return new Promise(async (resolve, reject) => {
            this.allPromisesRecursive().then(() => resolve(this)).catch(reject)
        })
    }
}

export class SerializedDocument {
    data: any
    ref: firebase.firestore.DocumentReference
    included: Object = {}
    promises: Object = {}
    _promisesArray: Promise<any>[] = []
    _includedArray: SerializedDocument[] = []
    snapshot: DocumentSnapshot

    constructor(documentSnapshot: DocumentSnapshot, includeConfig: IncludeConfig | 'ALL' = {}) {
        this.data = documentSnapshot.data()
        this.snapshot = documentSnapshot;
        this.ref = documentSnapshot.ref
        this.processIncludes(includeConfig)
        this.data = serializedDocumentTransformer(this).data;
    }

    static createLocal = (ref: DocumentReference, data: any = {}, includeConfig: IncludeConfig | 'ALL' = {}): SerializedDocument => {
        const serializedDocument = new SerializedDocument({ref, data: () => data} as DocumentSnapshot, includeConfig);
        serializedDocument.data = data;
        serializedDocument.ref = ref;
        serializedDocument.data = serializedDocumentTransformer(serializedDocument).data;
        return serializedDocument;
    }

    static fromDocumentReference = (ref: DocumentReference, includeConfig: IncludeConfig | 'ALL'): SerializedDocumentPromise => {
        return new SerializedDocumentPromise((resolve: any, reject: any) => {
            getCachedDocumentSnapshotPromise(ref)
                .then(documentSnapshot => resolve(new SerializedDocument(documentSnapshot, includeConfig)))
                .catch(reject);
        })
    }

    static fromJSON = (obj: string, firestore: Firestore): SerializedDocument => fromJSON(obj, firestore)

    static toJSON = (obj: any): string => toJSON(obj)

    processIncludes = (includeConfig: IncludeConfig | 'ALL') => {
        // Special case that recursively finds documentReferences and includes them.
        if (includeConfig === 'ALL') {
            console.log('All received');
            return this.findReferences(this.data, [])
        }

        Object.entries(includeConfig).forEach(([path, includeValue]) => {
            const valueInData = _.get(this.data, path)

            // Is simple relation pointing to a reference on document data
            if (valueInData && valueInData.get !== undefined) {
                return this.includeDocumentReference(path, valueInData, includeValue)
            }

            //Is nested array relation SerializedDocument[]
            if (Array.isArray(valueInData)) {
                return this.includeReferenceArray(path, valueInData, includeValue)
            }

            //Is nested object relation {key1: SerializedDocument, key2: SerializedDocument}
            if (typeof valueInData === 'object' && valueInData !== null) {
                return Object.entries(valueInData)
                    .forEach(([key, documentReference]) => {
                        this.includeDocumentReference(`${path}.${key}`, documentReference as DocumentReference, includeValue)
                    })
            }

            //Is function relation, the function will return a reference to be included.
            if (typeof includeValue === 'function') {
                const returnedValue = includeValue(this);
                if (isCollectionReferenceOrQuery(returnedValue)) {
                    return this.includeCollectionReferenceOrQuery(path, returnedValue)
                } else if (isDocumentReference(returnedValue)) {
                    return this.includeDocumentReference(path, returnedValue)
                }

            }
        })
    }

    includeReferenceArray = (path: string, documentReferenceArray: DocumentReference[], includeConfig = {}) => {
        _.set(this.included, path, [])
        _.set(this.promises, path, [])
        documentReferenceArray.forEach((documentReference: DocumentReference) => {
            const promise = new Promise((resolve, reject) => {
                getCachedDocumentSnapshotPromise(documentReference).then(documentSnapshot => {
                    const includedSerializedDocument = serializedDocumentTransformer(new SerializedDocument(documentSnapshot, includeConfig))
                    _.get(this.included, path).push(includedSerializedDocument)
                    this._includedArray.push(includedSerializedDocument);
                    resolve(includedSerializedDocument)
                }).catch(reject)
            })
            _.get(this.promises, path).push(promise)
            this._promisesArray.push(promise);
        })
    }

    includeDocumentReference = (path: string, documentReference: DocumentReference, includeConfig = {}) => {
        const promise = new Promise((resolve, reject) => {
            getCachedDocumentSnapshotPromise(documentReference).then(documentSnapshot => {
                const includedSerializedDocument = serializedDocumentTransformer(new SerializedDocument(documentSnapshot, includeConfig))
                _.set(this.included, path, includedSerializedDocument)
                this._includedArray.push(includedSerializedDocument);
                resolve(includedSerializedDocument)
            }).catch(reject)
        })
        _.set(this.promises, path, promise)
        this._promisesArray.push(promise);
    }

    includeCollectionReferenceOrQuery = (path: string, collectionReferenceOrQuery: CollectionReference | Query, includeConfig = {}) => {
        const promise = new Promise(async (resolve, reject) => {
            SerializedDocumentArray.fromQuery(collectionReferenceOrQuery, includeConfig).then(serializedDocumentArray => {
                _.set(this.included, path, serializedDocumentArray);
                resolve(serializedDocumentArray)
            }).catch(reject)
        });
        _.set(this.promises, path, promise)
        this._promisesArray.push(promise);
    }

    findReferences = (data: { [key: string]: any }, _pathSegments: Array<string>) => {
        if (data) {
            Object.entries(data).forEach(([property, value]) => {
                const pathSegments = [..._pathSegments, property];
                if (isDocumentReference(value)) { //Is documentReference
                    this.includeDocumentReference(buildReferencePathFromSegments(pathSegments), value);
                } else if (Array.isArray(value)) { // Array
                    value.forEach((arrayValue: any, index) => {
                        const itemPathSegments = [...pathSegments, `[${index}]`];
                        if (isPlainObject(arrayValue)) {
                            this.findReferences(arrayValue, itemPathSegments);
                        } else if (isDocumentReference(arrayValue)) {
                            this.includeDocumentReference(buildReferencePathFromSegments(itemPathSegments), arrayValue)
                        }
                    });
                } else if (isPlainObject(value)) { // Is an object, not a reference nor a date!
                    this.findReferences(value, pathSegments); // Regular object {}
                }
            })
        }
    }

    allPromisesRecursive = () => new Promise((resolve, reject) => {
        Promise.all(this._promisesArray).then(() => {
            const allPromises: Promise<any>[] = []

            this._includedArray.forEach((includedValue: SerializedDocument) => {
                allPromises.push(includedValue.allPromisesRecursive())
            })
            Promise.all(allPromises).then(res => {
                resolve(res)
            })
        }).catch(reject)
    })

    ready = () => new Promise(async (resolve, reject) => {
        this.allPromisesRecursive().then(() => resolve(this)).catch(reject)
    })

    toJSON = () => toJSON(this)
}

function transformDates(serializedDocument: SerializedDocument) {
    serializedDocument.data = transformDatesHelper(serializedDocument.data);
    return serializedDocument;
}

function transformDatesHelper(data: { [key: string]: any }) {
    if (data) Object.entries(data).forEach(([property, value]) => {
        if (Array.isArray(value)) { // Array
            value.forEach((arrayValue: any, index) => {
                if (isPlainObject(arrayValue)) {
                    value[index] = transformDatesHelper(arrayValue);
                }
            });
        } else if (typeof value?.toDate === 'function') { // Firestore timestamp
            data[property] = value.toDate();
        } else if (isPlainObject(value)) { // Is an object, not a reference nor a date!
            data[property] = transformDatesHelper(value); // Regular object {}
        }
    });
    ``
    return data;
}

function isPlainObject(value: any) {
    return Object.prototype.toString.call(value) == '[object Object]' && value.constructor.name === 'Object';
}

function buildReferencePathFromSegments(pathSegments: Array<string>): string {
    return pathSegments.join('.').replaceAll('.[', '[');
}

function isDocumentReference(value: any) {
    return typeof value?.get === 'function';
}

function isCollectionReferenceOrQuery(value: any) {
    return typeof value?.where === 'function' && typeof value?.get === 'function';
}

export function setCacheTimeout(milliseconds: number) {
    cacheTimeout = milliseconds;
}

export function setSerializedDocumentTransformer(transformerFunction: Function) {
    serializedDocumentTransformer = transformerFunction;
}

export function getCachedDocumentSnapshotPromise(documentReference: DocumentReference): CachedDocumentSnapshotPromise {
    if (documentReferencePromiseMapCache[documentReference.path]?.time + cacheTimeout > Date.now()) {
        return documentReferencePromiseMapCache[documentReference.path];
    } else {
        const documentSnapshotPromise = (documentReference.get()) as CachedDocumentSnapshotPromise;
        documentSnapshotPromise.time = Date.now();
        return documentReferencePromiseMapCache[documentReference.path] = documentSnapshotPromise;
    }
}

function convertRefToJoinRef(ref: firebase.firestore.DocumentReference) {
    return {
        _type: 'DocumentReference',
        path: ref.path
    }
}

function convertJSDateToJoinDate(obj: Date) {
    return {
        _type: 'Date',
        value: obj.toString()
    }
}

function preprocessObjectToStringify(data: any) {
    if (data) {
        if (data instanceof SerializedDocument) {
            data = _.pick(data, ['data', 'included', 'ref', 'snapshot'])
            data.snapshot = {
                ref: convertRefToJoinRef(data.ref),
                id: data.snapshot.id,
                exists: data.snapshot.exists
            }
        }

        if (isDocumentReference(data)) {
            return convertRefToJoinRef(data)
        } else if (isJSDate(data)){
            return convertJSDateToJoinDate(data)
        } else if ((typeof data === 'object')){
            for (let key in data) {
                data[key] = preprocessObjectToStringify(data[key])
            }
        }
    }
    return data;
}

function convertJoinRefToRef(JoinRef: JoinRef, firestore: Firestore) {
    const isDoc = JoinRef.path.split('/').length % 2 === 0;
    if(isDoc) {
        return firestore.doc(JoinRef.path);
    }
    return firestore.collection(JoinRef.path);
}

function convertJoinDateToJSDate(joinDate: JoinDate) {
   return new Date(joinDate.value);
}

export function toJSON(data: { [key: string]: any }) {
    const copy = _.cloneDeep(data);
    const toStringify = preprocessObjectToStringify(copy);
    return JSON.stringify(toStringify);
}

function isJoinRef(obj: any) {
    if (typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    if (keys.length === 2 &&  obj._type === 'DocumentReference') {
        return true;
    }
    return false;
}

function isJSDate(obj: any) {
    return obj instanceof Date
}

function isJoinDate(obj: any) {
    if (typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    if (keys.length === 2 &&  obj._type === 'Date') {
        return true;
    }
    return false;
}

function processParsedJoinJSON(data: any, firestore: Firestore) {
    if (data) {
        if(isJoinRef(data)) {
            return convertJoinRefToRef(data, firestore)
        } else if(isJoinDate(data)) {
            return convertJoinDateToJSDate(data)
        } else if(typeof data === 'object') {
            for (let key in data) {
                data[key] = processParsedJoinJSON(data[key], firestore)
            }
        }
    }
    return data;
}

export function fromJSON(data: string, firestore: Firestore) {
   const obj = JSON.parse(data);
   return processParsedJoinJSON(obj, firestore);
}

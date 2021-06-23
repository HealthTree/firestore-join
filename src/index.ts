import 'core-js/features/promise'
import firebase from 'firebase'
import _ from 'lodash'
import DocumentReference = firebase.firestore.DocumentReference
import DocumentSnapshot = firebase.firestore.DocumentSnapshot
import QuerySnapshot = firebase.firestore.QuerySnapshot
import Query = firebase.firestore.Query;

let cacheTimeout: number = 3000;

let documentReferencePromiseMapCache: { [key: string]: CachedDocumentSnapshotPromise } = {};

let serializedDocumentTransformer: Function = transformDates;

export interface CachedDocumentSnapshotPromise extends Promise<DocumentSnapshot> {
    time: number
}

export interface IncludeConfig {
    [key: string]: Function | Object;
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
    constructor(querySnapshot: QuerySnapshot, includesConfig: IncludeConfig) {
        let docs: SerializedDocument[] = []
        if (querySnapshot.docs) {
            docs = querySnapshot.docs.map(doc => {
                return new SerializedDocument(doc, includesConfig)
            })
        }
        super(...docs)
    }

    static fromDocumentReferenceArray = (documentReferenceArray: [DocumentReference], includesConfig: IncludeConfig): SerializedDocumentArrayPromise => {
        return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
            Promise.all(documentReferenceArray.map(documentReference => SerializedDocument.fromDocumentReference(documentReference, includesConfig))).then(serializedDocuments => {
                resolve(Object.setPrototypeOf(serializedDocuments, SerializedDocumentArray.prototype))
            }).catch(reject);
        })
    }

    static fromQuery = (query: Query, includesConfig: IncludeConfig): SerializedDocumentArrayPromise => {
        return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
            query.get().then(querySnapshot => {
                resolve(new SerializedDocumentArray(querySnapshot, includesConfig))
            }).catch(reject);
        });
    }

    allPromises() {
        return Promise.all(this.map(doc => Promise.all(doc.promisesArray)))
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
    promisesArray: Promise<any>[] = []
    includedArray: SerializedDocument[] = []

    constructor(documentSnapshot: DocumentSnapshot, includeConfig: IncludeConfig = {}) {
        this.data = documentSnapshot.data()
        this.ref = documentSnapshot.ref
        this.processIncludes(includeConfig)
        this.data = serializedDocumentTransformer(this).data;
    }

    static createLocal = (ref: DocumentReference, data: any = {}): SerializedDocument => {
        const serializedDocument = Object.create(SerializedDocument);
        serializedDocument.ref = ref;
        serializedDocument.data = data;
        return serializedDocument;
    }

    static fromDocumentReference = (ref: DocumentReference, includeConfig: IncludeConfig): SerializedDocumentPromise => {
        return new SerializedDocumentPromise((resolve: any, reject: any) => {
            getCachedDocumentSnapshotPromise(ref)
                .then(documentSnapshot => resolve(new SerializedDocument(documentSnapshot, includeConfig)))
                .catch(reject);
        })
    }

    processIncludes = (includeConfig: IncludeConfig) => {
        Object.entries(includeConfig).forEach(([path, includeValue]) => {
            const valueInData = _.get(this.data, path)

            if (valueInData && valueInData.get !== undefined) { // Is simple relation pointing to a reference on document data
                return this.includeReference(path, valueInData, includeValue)
            }

            if (Array.isArray(valueInData)) {//Is nested array relation SerializedDocument[]
                return this.includeReferenceArray(path, valueInData, includeValue)
            }

            if (typeof valueInData === 'object' && valueInData !== null) {//Is nested object relation {key1: SerializedDocument, key2: SerializedDocument}
                return Object.entries(valueInData)
                    .forEach(([key, documentReference]) => {
                        this.includeReference(`${path}.${key}`, documentReference as DocumentReference, includeValue)
                    })
            }

            if (typeof includeValue === 'function') { //Is function relation, the function will return a reference to be included.
                return this.includeReference(path, includeValue(this))
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
                    this.includedArray.push(includedSerializedDocument);
                    resolve(includedSerializedDocument)
                }).catch(reject)
            })
            _.get(this.promises, path).push(promise)
            this.promisesArray.push(promise);
        })
    }

    includeReference = (path: string, documentReference: DocumentReference, includeConfig = {}) => {
        const promise = new Promise((resolve, reject) => {
            getCachedDocumentSnapshotPromise(documentReference).then(documentSnapshot => {
                const includedSerializedDocument = serializedDocumentTransformer(new SerializedDocument(documentSnapshot, includeConfig))
                _.set(this.included, path, includedSerializedDocument)
                this.includedArray.push(includedSerializedDocument);
                resolve(includedSerializedDocument)
            }).catch(reject)
        })
        _.set(this.promises, path, promise)
        this.promisesArray.push(promise);
    }


    allPromisesRecursive = () => new Promise((resolve, reject) => {
        Promise.all(this.promisesArray).then(() => {
            const allPromises: Promise<any>[] = []

            this.includedArray.forEach((includedValue: SerializedDocument) => {
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
    return data;
}

function isPlainObject(value: any) {
    return Object.prototype.toString.call(value) == '[object Object]' && value.constructor.name === 'Object';
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
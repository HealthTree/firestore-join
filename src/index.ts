import 'core-js/features/promise';
import _ from 'lodash';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import DocumentReference = firebase.firestore.DocumentReference;
import DocumentSnapshot = firebase.firestore.DocumentSnapshot;
import QuerySnapshot = firebase.firestore.QuerySnapshot;
import Query = firebase.firestore.Query;
import CollectionReference = firebase.firestore.CollectionReference;
import Firestore = firebase.firestore.Firestore;

let cacheTimeout: number = 3000;

const FIREBASE_QUERY_DISJUNCTION_LIMIT = 30;

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

interface QueryHiddenProps {
    _delegate: {
        _query: {
            collectionGroup: string,
            filters: any[],
            endAt: any,
            limit: number,
            path: { segments: string[] },
            startAt: any,
            explicitOrderBy?: {
                field: {
                    len: number,
                    offset: number,
                    segments: string[],
                },
                dir: any  }[]
        }
    }
}

let firestoreInstance: Firestore;

export function setFirestoreInstance(firestore: Firestore) {
    firestoreInstance = firestore;
}
export class SerializedDocumentPromise<T extends SerializedInterface<T>> extends Promise<SerializedDocument<T>> {
    ready = (): Promise<SerializedDocument<T>> => new Promise(async (resolve, reject) => {
        this.then((serializedDocument: SerializedDocument<T>) => {
            serializedDocument.ready().then(resolve).catch(reject)
        }).catch(reject)
    })

    constructor(fn: any) {
        super(fn);
    }
}

export class SerializedDocumentArrayPromise<T extends SerializedInterface<T>> extends Promise<SerializedDocumentArray<T>> {
    ready = (): Promise<SerializedDocumentArray<T>> => new Promise(async (resolve, reject) => {
        this.then((serializedDocumentArray: SerializedDocumentArray<T>) => {
            serializedDocumentArray?.ready().then(resolve).catch(reject)
        }).catch(reject)
    })

    constructor(fn: any) {
        super(fn);
    }
}

export class SerializedDocumentArray<T extends SerializedInterface<T>> extends Array<SerializedDocument<T>> {
    constructor(querySnapshot: QuerySnapshot, includesConfig: IncludeConfig | 'ALL' = {}) {
        let docs: SerializedDocument<any>[] = []
        if (querySnapshot.docs) {
            docs = querySnapshot.docs.map(doc => {
                return new SerializedDocument(doc, includesConfig)
            })
        }
        super(...docs)
    }

    static fromDocumentReferenceArray =<T extends SerializedInterface<T>> (documentReferenceArray: [DocumentReference], includesConfig: IncludeConfig | 'ALL' = {}): SerializedDocumentArrayPromise<T> => {
        return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
            Promise.all(documentReferenceArray.map(documentReference => SerializedDocument.fromDocumentReference(documentReference, includesConfig))).then(serializedDocuments => {
                resolve(Object.setPrototypeOf(serializedDocuments, SerializedDocumentArray.prototype))
            }).catch(reject);
        })
    }

    static fromQuery = <T extends SerializedInterface<T>>(
        collectionReferenceOrQuery: (CollectionReference | Query) | ((CollectionReference | Query) & QueryHiddenProps),
        includesConfig: IncludeConfig | 'ALL' = {}, firestore: Firestore = firestoreInstance
    ): SerializedDocumentArrayPromise<T> => {
        const _query = (collectionReferenceOrQuery as (CollectionReference | Query) & QueryHiddenProps)._delegate._query;
        if (_query.filters?.some((filter: any) =>
            filter.op === 'array-contains-any'
            && filter.value?.arrayValue?.values?.length > FIREBASE_QUERY_DISJUNCTION_LIMIT)
        ) {

            const filterIndex = _query.filters?.findIndex((filter: any) => filter.op === 'array-contains-any');
            if (filterIndex !== -1) {
                const originalFilter = _query.filters[filterIndex];
                let valuesToChunk = originalFilter.value.arrayValue.values;
                const chunkedValues = _.chunk(valuesToChunk, FIREBASE_QUERY_DISJUNCTION_LIMIT);
                const originalQuery = collectionReferenceOrQuery as (CollectionReference | Query) & QueryHiddenProps;

                const promises = chunkedValues.map(async (chunk: any) => {
                    const newQuery = _.cloneDeep(originalQuery);
                    newQuery._delegate._query.filters[filterIndex].value = {arrayValue: {values: chunk}}; // chunk;
                    const finalQuery = constructNewQueryFromQuery(newQuery, firestore);
                    try {
                        return finalQuery.get();
                    } catch (e) {
                        console.error('Error splitting query', e);
                        return {docs: []} as unknown as QuerySnapshot;
                    }
                });

                return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
                    Promise.all(promises).then((querySnapshots) => {
                        const mergedDocsMap: { [key: string]: DocumentSnapshot } = {};
                        querySnapshots.forEach(querySnapshot => {
                            querySnapshot.docs.forEach((doc: DocumentSnapshot<firebase.firestore.DocumentData>) => {
                                mergedDocsMap[doc.id] = doc;
                            })
                        });
                        let mergedDocs = Object.values(mergedDocsMap);

                        if (originalQuery._delegate._query.explicitOrderBy) {
                            let orders = originalQuery._delegate._query.explicitOrderBy;
                            let fields = orders.map(order => ['data'].concat(order.field.segments));
                            let directions = orders.map(order => order.dir);
                            mergedDocs = _.orderBy(mergedDocs, fields, directions) as unknown as DocumentSnapshot[];
                        }
                        if (originalQuery._delegate._query.limit) {
                            mergedDocs = _.take(mergedDocs, originalQuery._delegate._query.limit);
                        }

                        const mergedQuerySnapshot = {docs: mergedDocs} as QuerySnapshot;

                            resolve(new SerializedDocumentArray(mergedQuerySnapshot, includesConfig));
                    }).catch(reject);
                });
            } else {
                console.warn('array-contains-any filter not found');
                return [] as unknown as SerializedDocumentArrayPromise<T>;
            }

        } else {
            return new SerializedDocumentArrayPromise(async (resolve: any, reject: any) => {
                collectionReferenceOrQuery.get().then(querySnapshot => {
                    resolve(new SerializedDocumentArray(querySnapshot, includesConfig))
                }).catch(reject);
            });
        }
    }

    static fromJSON = (obj: string, firestore: Firestore): SerializedDocumentArray<any> => fromJSON(obj, firestore)

    allPromises() {
        return Promise.all(this.map(doc => Promise.all(doc._promisesArray)))
    }

    allPromisesRecursive() {
        return Promise.all(this.map(doc => doc.allPromisesRecursive()))
    }

    ready(): Promise<SerializedDocumentArray<T>> {
        return new Promise(async (resolve, reject) => {
            this.allPromisesRecursive().then(() => resolve(this)).catch(reject)
        })
    }

    JSONStringify() {return toJSON(this)}
}

interface SerializedInterface<T> extends Partial<SerializedDocument<T>> {}

export class SerializedDocument<T extends SerializedInterface<T>> {
    data: T['data']
    ref: firebase.firestore.DocumentReference
    included: T['included'] = {}
    promises: Object = {}
    _promisesArray: Promise<any>[] = []
    _includedArray: SerializedDocument<T>[] = []
    snapshot: DocumentSnapshot

    constructor(documentSnapshot: DocumentSnapshot, includeConfig: IncludeConfig | 'ALL' = {}) {
        this.data = documentSnapshot.data();
        this.snapshot = documentSnapshot;
        this.ref = documentSnapshot.ref;
        this.processIncludes(includeConfig);
        this.data = serializedDocumentTransformer(this).data;
    }

    static createLocal = <T extends SerializedInterface<T>>(ref: DocumentReference, data: any = {}, includeConfig: IncludeConfig | 'ALL' = {}): SerializedDocument<T> => {
        const serializedDocument = new SerializedDocument({ref, data: () => data} as DocumentSnapshot, includeConfig) as SerializedDocument<T>;
        serializedDocument.data = data;
        serializedDocument.ref = ref;
        serializedDocument.data = serializedDocumentTransformer(serializedDocument).data;
        return serializedDocument;
    }

    static fromDocumentReference = <T extends SerializedInterface<T>>(ref: DocumentReference, includeConfig: IncludeConfig | 'ALL' = {}): SerializedDocumentPromise<T> => {
        return new SerializedDocumentPromise((resolve: any, reject: any) => {
            getCachedDocumentSnapshotPromise(ref)
                .then(documentSnapshot => resolve(new SerializedDocument(documentSnapshot, includeConfig)))
                .catch(reject);
        })
    }

    static fromJSON = (obj: string, firestore: Firestore): SerializedDocument<any> => fromJSON(obj, firestore)

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
        _.set(this.included as object, path, [])
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
                _.set(this.included as object, path, includedSerializedDocument)
                this._includedArray.push(includedSerializedDocument);
                resolve(includedSerializedDocument)
            }).catch(reject)
        })
        _.set(this.promises, path, promise)
        this._promisesArray.push(promise);
    }

    includeCollectionReferenceOrQuery = (path: string, collectionReferenceOrQuery: (CollectionReference | Query) & {_delegate: {_query: any}, filters: any[]} , includeConfig = {}) => {
        const promise = new Promise(async (resolve, reject) => {
            SerializedDocumentArray.fromQuery(collectionReferenceOrQuery, includeConfig).then(serializedDocumentArray => {
                _.set(this.included as object, path, serializedDocumentArray);
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

            this._includedArray.forEach((includedValue: SerializedDocument<T>) => {
                allPromises.push(includedValue.allPromisesRecursive())
            })
            Promise.all(allPromises).then(res => {
                resolve(res)
            })
        }).catch(reject)
    })

    ready = (): Promise<SerializedDocument<T>> => new Promise(async (resolve, reject) => {
        this.allPromisesRecursive().then(() => resolve(this)).catch(reject)
    })

    JSONStringify = () => toJSON(this)
}

function transformDates<T extends SerializedInterface<T>>(serializedDocument: SerializedDocument<T>) {
    serializedDocument.data = transformDatesHelper(serializedDocument.data);
    return serializedDocument;
}

function transformDatesHelper(data: any) {
    if (data) Object.entries(data).forEach(([property, value]: [string, any]) => {
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

// Convert inner firestore v8 filter values into JS values (compatible with modular v9)
const deserializeValue = (value: any) => {
    if (value.hasOwnProperty('stringValue')) {
        return value.stringValue;
    } else if (value.hasOwnProperty('doubleValue')) {
        return parseFloat(value.doubleValue);
    } else if (value.hasOwnProperty('integerValue')) {
        return parseInt(value.integerValue);
    } else if (value.hasOwnProperty('booleanValue')) {
        return value.booleanValue;
    } else if (value.hasOwnProperty('referenceValue')) {
        return firestoreInstance.doc(
            value.referenceValue.replace(
                `projects/${(firestoreInstance as any)._databaseId.projectId}/databases/${
                    (firestoreInstance as any)._databaseId.database
                }/documents`,
                ''
            )
        );
    } else if (value.hasOwnProperty('timestampValue')) {
        return new Date(value.timestampValue);
    } else if (value.hasOwnProperty('nullValue')) {
        return null;
    } else if (value.hasOwnProperty('arrayValue')) {
        return value.arrayValue.values.map(deserializeValue);
    } else {
        console.error('Unknown value type', value);
    }
};

function constructNewQueryFromQuery(originalQuery: Query & QueryHiddenProps, firestore: Firestore): Query {
    const originalQueryProps = (originalQuery as QueryHiddenProps)._delegate._query;
    // Initialize new query with the same collection reference
    let newQuery: firebase.firestore.Query = firestore.collection(originalQueryProps.path.segments.join('/'));
    // Apply properties from the original query to the new query
    if (originalQueryProps.filters) {
        originalQueryProps.filters.forEach(filter => {
            let field = filter.field.segments.join('.');
            let value = deserializeValue(filter.value);
            newQuery = newQuery.where(field, filter.op, value);
        });
    }
    if (originalQueryProps.endAt) {
        newQuery = newQuery.endAt(originalQueryProps.endAt);

    }
    if (originalQueryProps.limit) {
        newQuery = newQuery.limit(originalQueryProps.limit);
    }
    if (originalQueryProps.startAt) {
        newQuery = newQuery.startAt(originalQueryProps.startAt);
    }
    if (originalQueryProps.explicitOrderBy && originalQueryProps.explicitOrderBy?.length > 0) {
        originalQueryProps.explicitOrderBy.forEach(order => {
            newQuery = newQuery.orderBy(order.field.segments.join('.'), order.dir);
        });
    }
    return newQuery;
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

function preprocessObjectToStringify(key: any, value: any) {
    let returnVal: any;
    if (value !== undefined && key !== undefined) {
        if (value instanceof SerializedDocument) {
            let temp: any;
            temp = _.pick(value, ['data', 'included', 'ref'])
            temp.snapshot = {
                ref: convertRefToJoinRef(value.ref),
                id: value.snapshot.id,
                exists: value.snapshot.exists
            }
            returnVal = temp;
        } else if (isDocumentReference(value)) {
            returnVal = convertRefToJoinRef(value)
        }  else {
            if (typeof(value) === 'object') {
                for (const k in value) {
                    if (isJSDate(value[k])){
                        value[k] = convertJSDateToJoinDate(value[k])
                    }
                }
            }
            returnVal = value
        }
    }
    // sort json
    if(returnVal instanceof Object && !(returnVal instanceof Array)) {
        returnVal = Object.keys(returnVal)
            .sort()
            .reduce((sorted: any, key) => {
                sorted[key] = returnVal[key];
                return sorted
            }, {})
    }
    return returnVal;
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
    return JSON.stringify(copy, preprocessObjectToStringify);
}

function isJoinRef(obj: any) {
    if (typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    return keys.length === 2 && obj._type === 'DocumentReference';

}

function isJSDate(obj: any) {
    return obj instanceof Date
}

function isJoinDate(obj: any) {
    if (typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    return keys.length === 2 && obj._type === 'Date';

}

export function processParsedJoinJSON(data: any, firestore: Firestore) {
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

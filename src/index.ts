import 'core-js/features/promise'
import firebase from 'firebase'
import _ from 'lodash'
import DocumentReference = firebase.firestore.DocumentReference
import DocumentSnapshot = firebase.firestore.DocumentSnapshot
import QuerySnapshot = firebase.firestore.QuerySnapshot

let serializedDocumentTransformer: Function = transformDates;

export function setSerializedDocumentTransformer(transformerFunction: Function) {
    serializedDocumentTransformer = transformerFunction;
}

export interface IncludeConfig {
    [key: string]: Function | Object;
}

export interface SerializedDocumentNested {
    [key: string]: SerializedDocument;
}

export class SerializedDocumentArray extends Array {
    constructor(querySnapshot: QuerySnapshot, includesConfig: IncludeConfig) {
        let docs: SerializedDocument[] = []
        if (querySnapshot.docs) {
            docs = querySnapshot.docs.map(doc => {
                return new SerializedDocument(doc, includesConfig)
            })
        }
        super(...docs as any[])
    }

    allPromises() {
        return Promise.all(this.map(doc => doc.allPromises()))
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

    constructor(documentSnapshot: DocumentSnapshot, includeConfig: IncludeConfig = {}) {
        this.data = documentSnapshot.data()
        this.ref = documentSnapshot.ref
        this.processIncludes(includeConfig)
        this.data = serializedDocumentTransformer(this).data;
    }

    static createLocal = (ref: DocumentReference, data: any = {}) => {
        const serializedDocument = Object.create(SerializedDocument);
        serializedDocument.ref = ref;
        serializedDocument.data = data;
        return serializedDocument;
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
                documentReference.get().then(documentSnapshot => {
                    const includedSerializedDocument = serializedDocumentTransformer(new SerializedDocument(documentSnapshot, includeConfig))
                    _.get(this.included, path).push(includedSerializedDocument)
                    resolve(includedSerializedDocument)
                }).catch(reject)
            })
            _.get(this.promises, path).push(promise)
        })
    }

    includeReference = (path: string, documentReference: DocumentReference, includeConfig = {}) => {
        const promise = new Promise((resolve, reject) => {
            documentReference.get().then(documentSnapshot => {
                const includedSerializedDocument = serializedDocumentTransformer(new SerializedDocument(documentSnapshot, includeConfig))
                _.set(this.included, path, includedSerializedDocument)
                resolve(includedSerializedDocument)
            }).catch(reject)
        })
        _.set(this.promises, path, promise)
    }

    allPromises = () => Promise.all(this.flattenPromises(Object.values(this.promises)))

    flattenPromises = (values: any[]) => {
        let promises: any[] = [];
        values.forEach(value => {
            if (typeof value.then === 'function') {

                promises.push(value)
            } else if (Array.isArray(value)) {
                promises = [...promises, ...this.flattenPromises(value)];
            } else if (typeof value === 'object') {
                promises = [...promises, ...this.flattenPromises(Object.values(value))];
            }
        })
        return promises;
    }

    allPromisesRecursive = () => new Promise((resolve, reject) => {
        this.allPromises().then(() => {
            const allPromises: Promise<any>[] = []

            Object.values(this.included).forEach((includedValue: SerializedDocument | Array<SerializedDocument> | SerializedDocumentNested) => {
                //Is single document relation
                if (includedValue instanceof SerializedDocument) {
                    return allPromises.push(includedValue.allPromisesRecursive())
                }

                //Is nested array relation SerializedDocument[]
                if (Array.isArray(includedValue)) {
                    includedValue.forEach((serializedDocument: SerializedDocument) => allPromises.push(serializedDocument.allPromisesRecursive()))
                }

                //Is nested object relation {key1: SerializedDocument, key2: SerializedDocument}
                if (typeof includedValue === 'object' && includedValue !== null) {
                    return Object.values(includedValue)
                        .forEach((serializedDocument: SerializedDocument) => allPromises.push(serializedDocument.allPromisesRecursive()))
                }

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

function transformDates(serializedDocument: any) {
    Object.keys(serializedDocument.data).forEach(property => {
        if (serializedDocument.data[property]?.toDate !== undefined) {
            serializedDocument.data[property] = serializedDocument.data[property].toDate()
        }
    })
    return serializedDocument;
}
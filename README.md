# Firestore Join

Easily include references inside your document. 

Supports:

- Single references
- Arrays of references
- Maps pointing references
- Infinite nested references
- Cache so you don't include `.get()` the same reference more than once.

``npm i firebase-join``

# How to use:

1 - Install:
```
npm i firebase-join
```

2 - Import: 
```  
import { SerializedDocumentArray } from '@healthtree/firestore-join';
```

The building blocks for this library are `SerializedDocument` and `SerializedDocumentArray` classes & `IncludeConfig`.

```js
//Only recommended methods and properties are documented in this interface
interface SerializedDocument{
  // Data returned after calling documentSnapshot.data() and transforming the data, by default it converts firestore timestamps into JS dates.
  data: any 

  // Firestore document reference
  ref: firebase.firestore.DocumentReference 

  // Any included documents, as SerializedDocuments.
  included: Object = {} 

  // Promises for each included reference, this promises resolves once the document is returned by the server or cache.
  promises: Object = {} 
  
  // DocumentSnapshot of the document if document came from server.
  documentSnapshot: DocumentSnapshot

  constructor(documentSnapshot: DocumentSnapshot, includeConfig: IncludeConfig = {}) {
  ...
  }
  
  // Create and return a SerializedDocument that doesn't exist on firestore, useful to keep consistency.
  static createLocal = (ref: DocumentReference, data: any = {}, includeConfig: IncludeConfig = {}): SerializedDocument => {
  ...
  }

  // Gets the document reference and returns a SerializedDocument with any includeConfig
  static fromDocumentReference = (ref: DocumentReference, includeConfig: IncludeConfig): SerializedDocumentPromise => {
  ...  
  }
}
```

```js
// SerializedDocumentArray is basically an array of SerializedDocuments
// It implements a ready function to know when all included documents are ready

interface SerializedDocumentArray extends Array<SerializedDocument> {
    constructor(querySnapshot: QuerySnapshot, includesConfig: IncludeConfig) {
        
    }

    static fromDocumentReferenceArray = (documentReferenceArray: [DocumentReference], includesConfig: IncludeConfig): SerializedDocumentArrayPromise => {
    ...
    })
}
    // Returns a promise that resolves a SerializedDocumentArray
    // when the documents (without includes) are ready.
    static fromQuery = (query: Query, includesConfig: IncludeConfig): SerializedDocumentArrayPromise => {
    ...
    }
    // Returns a promise that resolves when all included documents are ready
    ready() {
    
    }
}
```

### To serialize an array of documents without including any references.

```js
const posts = await SerializedDocumentArray.fromQuery(firestore.collection('posts'));

// or with any firestore supported filters

const postsFromUser = await SerializedDocumentArray.fromQuery(firestore.collection('posts').where('user','==', userReference));
```

### To serialize an array of documents including a reference and waiting for all the included references to be ready.

Let's pretend each post has a property called user, where user is a documentReference of the user that created the post.

To include all the users, you pass an includeConfig object as the second parameter and call a ready function that returns a promise that resolves once all the references are resolved.

```js
const posts = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts'), 
  {user: true}
).ready();

// with any firestore supported filters
const postsFromUser = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts').where('user','==', userReference),
  {user: true}
).ready();
```


### To serialize an array of documents including a reference and waiting for all the included references to be ready.

Let's pretend each post has a property called user, where user is a documentReference of the user that created the post.

To include all the users, you pass an includeConfig object as the second parameter and call a ready function that returns a promise that resolves once all the references are resolved.

```js
const posts = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts'), 
  {user: true}
).ready();

// with any firestore supported filters
const postsFromUser = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts').where('user','==', userReference),
  {user: true}
).ready();

// with nested references to include
const posts = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts'),
  {user: {organization: true}}
).ready();


// You can access the included documents
console.log(posts[0].includes.user); // User data
console.log(posts[0].includes.user.includes.organization.data); // User->Organization data

// if included documents are an array
const posts = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts'),
  {
    user: true,
    tags: true
  }
).ready();

// You can access the included documents
console.log(posts[0].includes.tags); // Array of SerializedDocuments containing all tags
```

### Listen to firestore query snapshots and serialize
```js

// Only use if your use case really justifies real time updates.
let posts;
 firestore.collection('posts').onSnapshot(async querySnapshot => {
   posts = await new SerializedDocumentArray(querySnapshot, {user: true}).ready()
})
```

### When to use createLocal?
Let's pretend we have a page/component used create or edit a document in firestore.

```js
// Sample using svelte
onMount(async () => {
  const postId = $page.query.postId;
  let post;
  if(postId === 'new') {
    // Pass the desired reference and any initial data
    post = SerializedDocument.createLocal(db.collection('posts').doc(), {user: userReference})
  } else {
    post = await SerializedDocument.fromDocumentReference(db.collection('posts').doc(postId))
  }
})

// UI to modify the message on post, no need for double ui if post is new

onSave = () => {
  post.ref.set(post.data); 
  // No need to have extra logic to see if it was a new doc
}
```

### Advanced - Include documents but listen to individual include to be ready.

```js
const posts = await SerializedDocumentArray.fromQuery(
  firestore.collection('posts'), 
  {user: true}
);

// We are not going to wait for includes to be ready, start rendering and only render user name when ready.

// Sample using svelte

{#each posts as post (post.ref.id)}
<div>
  {#await post.promises.user}
  <p>...waiting</p>
  {:then user}
  <p>From: {post.included.user.data.name}</p>
  {:catch error}
  
  {/await}
  {post.data.message}
</div>
{/each}

//This allows for fast, progressive ui rendering 
// where you don't have to wait for everything to be ready
```
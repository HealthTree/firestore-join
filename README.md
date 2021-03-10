# Firestore Join

Easily join firestore references inside documents. 

Supports:

- Single references
- Arrays of references
- Maps pointing references
- Infinite nested joins

``npm i firebase-join``

Example

Pretend you have a `users` collection that has a property called `company` which value is a firestore reference.
That `company` has a property called `country` which value is a firestore reference representing the country of that company.

To get the country of that user on a SQL DB you would normally do a join:

```
SELECT * FROM users JOIN companies on users.companyId = companies.id JOIN countries companies.countryId = countries.id
```
Or something like that...

On firestore there is no built in api for that, using firestore-join you can do it like this:

```
import {SerializedDocumentArray} from "firebase-join";
const querySnapshot = await firebase.firestore().collection('users').get()
const serializedDocuments = await new SerializedDocumentArray(querySnapshot,{company:{country:true}}).ready()
```

Real docs coming soon... :)
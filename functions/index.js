const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Filter = require("bad-words");
const { Expo } = require("expo-server-sdk");

admin.initializeApp();

const db = admin.firestore();
const filter = new Filter();

const sendNotifications = async (messages) => {
  const expo = new Expo();
  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  const promises = [];

  for (const chunk of chunks) {
    try {
      promises.push(expo.sendPushNotificationsAsync(chunk).then((ticketChunk) => tickets.push(...ticketChunk)));
    } catch (error) {
      console.error("error sending notifications", error);
    }
  }

  return Promise.all(promises);
};

const notifyRandomUser = async (uid) => {
  const currentUser = await db.collection("users").doc(uid).get();
  const userStats = await db.collection("users").doc("stats").get();
  let randomUser = 1;

  while (userStats.data().count > 1 && randomUser === currentUser.data().random_id) {
    const randVal = Math.random() * userStats.data().count;
    randomUser = Math.round(randVal) + 1;
    console.log(randomUser);
  }

  console.log(randomUser);

  const querySnapshot = await db.collection("users").where("random_id", "==", randomUser).limit(1).get();

  querySnapshot.forEach((doc) => {
    const token = doc.data().notification_token;
    console.log(token);
    if (Expo.isExpoPushToken(token)) {
      sendNotifications([
        {
          to: token,
          title: "Care to share your wisdom?",
          body: question,
          data: { convo_id: id, pending: true, primary: false },
        },
      ]);
    }
  });
};

//use transactions whenever multipler opeations rely on each other ex: write based on a get
//probably change this to notify the user their convo has been resolved instead
//remove the listener, then when u make get requests just say this convo has been deleted
exports.deleteMessages = functions.firestore.document("/conversations/{documentId}").onDelete(async (snap, context) => {
  promises = [];

  const qs = await db.collection("conversations").doc(context.params.documentId).collection("messages").get();

  qs.forEach((docSnapshot) => {
    promises.push(docSnapshot.ref.delete());
  });

  return Promise.all(promises);
});

exports.checkIfUserBanned = functions.firestore.document("/reports/{documentId}").onUpdate(async (change, context) => {
  const after = change.after.data();

  if (after.reports.length > 20) {
    const userDoc = await db.collection("users").doc(context.params.documentId).get();
    const token = userDoc.data().notification_token;
    if (Expo.isExpoPushToken(token)) {
      sendNotifications([
        { to: token, title: "Banned", body: "You've been reported multiple times and are now banned" },
      ]);
    }
    admin.auth().updateUser(context.params.documentId, {
      disabled: true,
    });
    //send a notification here through expo!
  }
});

exports.addConvoToUser = functions.firestore.document("conversations/{documentId}").onCreate((snap, context) => {
  return db
    .collection("users")
    .doc(snap.data().uid)
    .set(
      {
        conversations: {
          [context.params.documentId]: { question: snap.data().question, unread: false, primary: true },
        },
      },
      { merge: true }
    );
});

exports.createUser = functions.auth.user().onCreate(async (user) => {
  const stats = await db.collection("users").doc("stats").get();
  db.collection("users")
    .doc("stats")
    .set({ count: stats.data().count + 1 });
  return db
    .collection("users")
    .doc(user.uid)
    .set({
      conversations: [],
      rating: 0,
      random_id: stats.data().count + 1,
    });
});

exports.createConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const question = filter.clean(data.question);

  if (question.length > 200) {
    return false;
  }

  const currentUser = await db.collection("users").doc(uid).get();

  const numConvos = Object.keys(currentUser.data().conversations).length;
  if (numConvos >= 20) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "You can't be in more than 20 conversations at the same time, resolve an existing conversation to continue"
    );
  }

  const message = {
    text: question,
    timestamp: admin.firestore.Timestamp.now(),
    uid,
  };

  const convoDoc = await db.collection("conversations").add({
    question: question,
    pending_messages: [message],
    timestamp: admin.firestore.Timestamp.now(),
    uid,
    old_uids: [],
    pending: true,
  });
  const id = convoDoc.id;

  notifyRandomUser(uid);

  return id;
});

exports.markRead = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = await db.collection("users").doc(uid).get();

  if (doc.data().conversations.hasOwnProperty(data.convo_id)) {
    return db
      .collection("users")
      .doc(uid)
      .set(
        {
          conversations: { [data.convo_id]: { unread: false } },
        },
        { merge: true }
      );
  }
  return false;
});

exports.createMessage = functions.https.onCall(async (data, context) => {
  //verify data.text type of string - character cound, do this for data.question too TODO
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;
  const doc = await db.collection("conversations").doc(data.convo_id).get();
  if (doc.data().uid === uid || doc.data().new_uid === uid) {
    const text = filter.clean(data.text);
    const to_uid = doc.data().uid === uid ? doc.data().new_uid : doc.data().uid;
    if (to_uid) {
      const userDoc = await db.collection("users").doc(to_uid).get();
      const token = userDoc.data().notification_token;
      console.log("logging token");
      console.log(token);
      if (Expo.isExpoPushToken(token)) {
        sendNotifications([
          {
            to: token,
            title: doc.data().question,
            body: text,
            data: { convo_id: data.convo_id, pending: false, primary: doc.data().uid !== uid },
          },
        ]);
      }

      return createMessageHelper({
        text: text,
        convo_id: data.convo_id,
        uid,
        other_uid: to_uid,
      });
    }
  }
  return false;
});

async function createMessageHelper(data) {
  if (data.other_uid) {
    db.collection("users")
      .doc(data.other_uid)
      .set(
        {
          conversations: { [data.convo_id]: { unread: true } },
        },
        { merge: true }
      );
  }

  return db
    .collection("conversations")
    .doc(data.convo_id)
    .collection("messages")
    .add({
      text: data.text,
      uid: data.uid,
      timestamp: data.timestamp ? data.timestamp : admin.firestore.Timestamp.now(),
    });
}

exports.createPendingMessage = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;
  const doc = await db.collection("conversations").doc(data.convo_id).get();
  if (doc.data().uid === uid) {
    const text = filter.clean(data.text);
    return db
      .collection("conversations")
      .doc(data.convo_id)
      .update({
        pending_messages: admin.firestore.FieldValue.arrayUnion({
          text: text,
          uid,
          timestamp: admin.firestore.Timestamp.now(),
        }),
      });
  } else {
    return false;
  }
});

exports.removeUserFromConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;
  const doc = await db.collection("conversations").doc(data.convo_id).get();
  if (doc.data().uid === uid) {
    const promises = [];

    promises.push(
      db
        .collection("conversations")
        .doc(data.convo_id)
        .set(
          doc.data().new_uid
            ? {
                pending: true,
                new_uid: null,
                old_uids: admin.firestore.FieldValue.arrayUnion(doc.data().new_uid),
              }
            : { pending: true, new_uid: null },
          { merge: true }
        )
    );

    notifyRandomUser(uid);

    if (doc.data().new_uid) {
      promises.push(
        db
          .collection("users")
          .doc(doc.data().new_uid)
          .set(
            {
              conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
            },
            { merge: true }
          )
      );
    }

    promises.push(
      db
        .collection("users")
        .doc(uid)
        .set(
          {
            conversations: { [data.convo_id]: { unread: false } },
          },
          { merge: true }
        )
    );

    const qs = await db.collection("conversations").doc(data.convo_id).collection("messages").get();

    qs.forEach((docSnapshot) => {
      promises.push(docSnapshot.ref.delete());
    });

    await Promise.all(promises);

    return true;
  } else {
    return false;
  }
});

exports.addUserToConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = await db.collection("conversations").doc(data.convo_id).get();

  if (doc.data().pending && !doc.data().old_uids.includes(uid)) {
    db.collection("conversations").doc(data.convo_id).set({ pending: false, new_uid: uid }, { merge: true });

    doc.data().pending_messages.forEach((message) => {
      createMessageHelper({
        convo_id: data.convo_id,
        text: message.text,
        uid: doc.data().uid,
        timestamp: message.timestamp,
      });
    });

    db.collection("users")
      .doc(uid)
      .set(
        {
          conversations: { [data.convo_id]: { question: doc.data().question, unread: false, primary: false } },
        },
        { merge: true }
      );
    return true;
  } else {
    return false;
  }
});

exports.removeConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = await db.collection("conversations").doc(data.convo_id).get();
  if (doc.data().new_uid === uid) {
    const promises = [];
    promises.push(
      db
        .collection("conversations")
        .doc(data.convo_id)
        .set(
          {
            new_uid: null,
            old_uids: admin.firestore.FieldValue.arrayUnion(uid),
          },
          { merge: true }
        )
    );

    promises.push(
      db
        .collection("users")
        .doc(uid)
        .set(
          {
            conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
          },
          { merge: true }
        )
    );

    promises.push(
      createMessageHelper({
        text:
          "This user has left the conversation, you can either get a new opinion or resolve the conversation from the side menu.",
        convo_id: data.convo_id,
        uid,
        other_uid: doc.data().uid,
      })
    );

    await Promise.all(promises);

    return true;
  } else {
    return false;
  }
});

exports.report = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = await db.collection("conversations").doc(data.convo_id).get();
  const reported_uid = uid === doc.data().uid ? doc.data().new_uid : doc.data().uid;
  return db
    .collection("reports")
    .doc(reported_uid)
    .set({ reports: admin.firestore.FieldValue.arrayUnion(uid) }, { merge: true });
});

exports.addNotificationToken = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  return db.collection("users").doc(uid).set({ notification_token: data.notificationToken }, { merge: true });
});

exports.deleteConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = await db.collection("conversations").doc(data.convo_id).get();
  if (doc.data().uid === uid) {
    const promises = [];
    promises.push(db.collection("conversations").doc(data.convo_id).delete());

    if (doc.data().new_uid) {
      promises.push(
        db
          .collection("users")
          .doc(doc.data().new_uid)
          .set(
            {
              conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
            },
            { merge: true }
          )
      );
    }

    promises.push(
      db
        .collection("users")
        .doc(doc.data().uid)
        .set(
          {
            conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
          },
          { merge: true }
        )
    );

    await Promise.all(promises);
    return true;
  }
  return false;
});

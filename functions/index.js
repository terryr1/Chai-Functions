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

const notifyRandomUser = async (originalUid, question, convo_id) => {
  const statsDoc = db.collection("users").doc("stats");
  await db.runTransaction(async (t) => {
    const userStats = await t.get(statsDoc);

    let randomUser = userStats.data().next_id;

    if (randomUser === originalUid && randomUser + 1 <= userStats.data().count) {
      randomUser += 1;
    } else if (randomUser === originalUid) {
      randomUser = 1;
    }

    console.log(randomUser);

    t.set(statsDoc, { next_id: randomUser + 1 <= userStats.data().count ? randomUser + 1 : 1 }, { merge: true });

    const querySnapshot = await db.collection("users").where("random_id", "==", randomUser).limit(1).get();

    querySnapshot.forEach((doc) => {
      const token = doc.data().notification_token;
      if (Expo.isExpoPushToken(token)) {
        sendNotifications([
          {
            to: token,
            title: "Care to share your wisdom?",
            body: question,
            data: { convo_id: convo_id, pending: true, primary: false },
          },
        ]);
      }
    });
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
  }
});

exports.createUser = functions.auth.user().onCreate(async (user) => {
  const statsDoc = db.collection("users").doc("stats");

  const uid = await db.runTransaction(async (t) => {
    const stats = await t.get(statsDoc);
    t.set(statsDoc, { count: stats.data().count + 1 });
    return db
      .collection("users")
      .doc(user.uid)
      .set({
        conversations: [],
        rating: 0,
        random_id: stats.data().count + 1,
      });
  });

  return uid;
});

exports.createConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  if (uid === null) {
    return false;
  }

  const question = filter.clean(data.question);

  if (question.length > 200) {
    throw new functions.https.HttpsError("invalid-argument", "Your question can't be more than 200 characters long");
  }

  const currentUser = await db.collection("users").doc(uid).get();

  const numConvos = Object.keys(currentUser.data().conversations).length;
  if (numConvos >= 10) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "You can't create more than 10 conversations at the same time, resolve an existing conversation to continue"
    );
  }

  const _id = db.collection("conversations").doc().id;
  console.log(_id);
  const message = {
    _id,
    text: question,
    timestamp: admin.firestore.Timestamp.now(),
    uid,
  };

  const batch = db.batch();

  const convoDoc = db.collection("conversations").doc();
  batch.set(convoDoc, {
    question: question,
    pending_messages: [message],
    timestamp: admin.firestore.Timestamp.now(),
    uid,
    old_uids: [],
    pending: true,
  });

  const id = convoDoc.id;
  batch.set(
    db.collection("users").doc(uid),
    {
      conversations: {
        [id]: { question: question, unread: false, primary: true },
      },
    },
    { merge: true }
  );
  notifyRandomUser(currentUser.data().random_id, question, id);

  await batch.commit();
  return id;
});

exports.markRead = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const doc = db.collection("users").doc(uid);
  return db.runTransaction(async (t) => {
    const user = await t.get(doc);
    if (user.data().conversations[data.convo_id].unread) {
      return t.set(
        db.collection("users").doc(uid),
        {
          conversations: { [data.convo_id]: { unread: false } },
        },
        { merge: true }
      );
    }
    return false;
  });
});

exports.createMessage = functions.https.onCall(async (data, context) => {
  //verify data.text type of string - character cound, do this for data.question too TODO
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;
  const convDoc = db.collection("conversations").doc(data.convo_id);

  return db.runTransaction(async (transaction) => {
    const convo = await transaction.get(convDoc);

    if (convo.data().uid === uid || convo.data().new_uid === uid) {
      const text = filter.clean(data.text);
      const to_uid = convo.data().uid === uid ? convo.data().new_uid : convo.data().uid;
      if (to_uid) {
        const userDoc = db.collection("users").doc(to_uid);
        const userToBeNotified = await transaction.get(userDoc);

        const token = userToBeNotified.data().notification_token;
        if (Expo.isExpoPushToken(token)) {
          sendNotifications([
            {
              to: token,
              title: convo.data().question,
              body: text,
              data: { convo_id: data.convo_id, pending: false, primary: convo.data().uid !== uid },
            },
          ]);
        }

        return createMessageHelper(
          {
            text: text,
            convo_id: data.convo_id,
            uid,
            other_uid: to_uid,
            message_id: data.message_id,
          },
          transaction
        );
      }
    }

    return false;
  });
});

async function createMessageHelper(data, transaction) {
  if (data.other_uid) {
    transaction.set(
      db.collection("users").doc(data.other_uid),
      {
        conversations: { [data.convo_id]: { unread: true } },
      },
      { merge: true }
    );
  }

  const messageDoc = db.collection("conversations").doc(data.convo_id).collection("messages").doc(data.message_id);
  return transaction.set(messageDoc, {
    _id: data.message_id,
    text: data.text,
    uid: data.uid,
    timestamp: data.timestamp ? data.timestamp : admin.firestore.Timestamp.now(),
  });
}

exports.createPendingMessage = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);

    if (doc.data().uid === uid) {
      const text = filter.clean(data.text);
      return transaction.update(convoDoc, {
        pending_messages: admin.firestore.FieldValue.arrayUnion({
          _id: data.message_id,
          text: text,
          uid,
          timestamp: admin.firestore.Timestamp.now(),
        }),
      });
    } else {
      return false;
    }
  });
});

exports.removeUserFromConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);
  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);

    if (doc.data().uid === uid) {
      const promises = [];

      const user = db.collection("users").doc(uid);
      const userDoc = await transaction.get(user);

      promises.push(
        transaction.set(
          convoDoc,
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

      notifyRandomUser(userDoc.data().random_id, doc.data().question, data.convo_id);

      const newUser = db.collection("users").doc(doc.data().new_uid);

      if (doc.data().new_uid) {
        promises.push(
          transaction.set(
            newUser,
            {
              conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
            },
            { merge: true }
          )
        );
      }

      promises.push(
        transaction.set(
          user,
          {
            conversations: { [data.convo_id]: { unread: false } },
          },
          { merge: true }
        )
      );

      const qs = await db.collection("conversations").doc(data.convo_id).collection("messages").get();

      qs.forEach((docSnapshot) => {
        transaction.delete(docSnapshot.ref);
      });

      return Promise.all(promises);
    } else {
      return false;
    }
  });
});

exports.addUserToConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);

    if (doc.data().pending && !doc.data().old_uids.includes(uid)) {
      transaction.set(convoDoc, { pending: false, new_uid: uid }, { merge: true });

      doc.data().pending_messages.forEach((message) => {
        createMessageHelper(
          {
            convo_id: data.convo_id,
            text: message.text,
            uid: doc.data().uid,
            timestamp: message.timestamp,
            message_id: message._id,
          },
          transaction
        );
      });

      transaction.set(
        db.collection("users").doc(uid),
        {
          conversations: { [data.convo_id]: { question: doc.data().question, unread: false, primary: false } },
        },
        { merge: true }
      );
      return true;
    }
    return false;
  });
});

exports.removeConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);
    if (doc.data().new_uid === uid) {
      const promises = [];
      promises.push(
        transaction.set(
          convoDoc,
          {
            new_uid: null,
            old_uids: admin.firestore.FieldValue.arrayUnion(uid),
          },
          { merge: true }
        )
      );

      promises.push(
        transaction.set(
          db.collection("users").doc(uid),
          {
            conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
          },
          { merge: true }
        )
      );

      const message_id = db.collection("conversations").doc(data.convo_id).collection("messages").doc().id;
      promises.push(
        createMessageHelper(
          {
            text:
              "This user has left the conversation, you can either get a new opinion or resolve the conversation from the side menu.",
            convo_id: data.convo_id,
            uid,
            other_uid: doc.data().uid,
            message_id,
          },
          transaction
        )
      );

      return Promise.all(promises);
    } else {
      return false;
    }
  });
});

exports.report = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);
    const reported_uid = uid === doc.data().uid ? doc.data().new_uid : doc.data().uid;
    return transaction.set(
      db.collection("reports").doc(reported_uid),
      { reports: admin.firestore.FieldValue.arrayUnion(uid) },
      { merge: true }
    );
  });
});

exports.addNotificationToken = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const token = data.notificationToken;
  if (Expo.isExpoPushToken(token)) {
    return db.collection("users").doc(uid).set({ notification_token: data.notificationToken }, { merge: true });
  }
  return false;
});

exports.clearNotificationToken = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);
  const uid = decodedToken.uid;
  return db.collection("users").doc(uid).set({ notification_token: null }, { merge: true });
});

exports.deleteConvo = functions.https.onCall(async (data, context) => {
  const decodedToken = await admin.auth().verifyIdToken(data.token);

  const uid = decodedToken.uid;

  const convoDoc = db.collection("conversations").doc(data.convo_id);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(convoDoc);
    if (doc.data().uid === uid) {
      const promises = [];
      promises.push(transaction.delete(convoDoc));

      if (doc.data().new_uid) {
        promises.push(
          transaction.set(
            db.collection("users").doc(doc.data().new_uid),
            {
              conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
            },
            { merge: true }
          )
        );
      }

      promises.push(
        transaction.set(
          db.collection("users").doc(doc.data().uid),
          {
            conversations: { [data.convo_id]: admin.firestore.FieldValue.delete() },
          },
          { merge: true }
        )
      );

      return Promise.all(promises);
    }
    return false;
  });
});

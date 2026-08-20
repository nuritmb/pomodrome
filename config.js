// Firebase Realtime Database config for the "pomodrome" project.
//
// These values are NOT secrets — they are public identifiers, and it is normal
// and expected that they sit in a public repo. What protects your room is
// (a) the random room id in the URL hash and (b) the database rules in
// README.md, which you must publish before sharing the link.
//
// storageBucket and messagingSenderId from the console snippet are omitted:
// this app only uses the database.

export const firebaseConfig = {
  apiKey: "AIzaSyCGe8MijN8VmO2iZKQZS-HBn09ae83w_Q0",
  authDomain: "pomodrome.firebaseapp.com",
  databaseURL: "https://pomodrome-default-rtdb.firebaseio.com",
  projectId: "pomodrome",
  appId: "1:249790526966:web:3f2fca0c332888a93cc3d7",
};

// Bump this if you ever want to abandon all existing rooms at once.
export const DATA_VERSION = "v1";

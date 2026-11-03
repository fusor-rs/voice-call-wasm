//! The voice call page. The engines' load, the call and its turns are signals here;
//! `web/app.js` runs the call and reports back through `engine` events.

mod app;
mod latency;

# Face Call

Live video call where your face is replaced by an uploaded picture.
React + Vite, Three.js, MediaPipe Face Landmarker, PeerJS.

    npm install
    npm run dev      # open http://localhost:5173

Deploy: push to GitHub and import the repo in Vercel (Vite is auto-detected).

## Calling
1. Both people open the site, click Start camera, and each gets a call ID.
2. One person pastes the other's ID and clicks Call.

## Using it in Zoom / Meet / WhatsApp
A web page cannot appear as a webcam. Use OBS Studio: add a Window Capture of this page
(Hide UI / Call Mode first), click Start Virtual Camera, then pick "OBS Virtual Camera" in your call app.

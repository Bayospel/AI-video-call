import { useCallback, useEffect, useRef, useState } from 'react';
import { FaceSwapStage } from './faceMesh';
import { createImageTracker, createVideoTracker } from './tracker';
import { createCallClient } from './call';

export default function App() {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const remoteRef = useRef(null);
  const stageRef = useRef(null);
  const trackerRef = useRef(null);
  const imgTrackerRef = useRef(null);
  const camStreamRef = useRef(null);
  const outStreamRef = useRef(null);
  const callRef = useRef(null);
  const faceSeenRef = useRef(false);

  const [uiHidden, setUiHidden] = useState(false);
  const [cam, setCam] = useState('idle'); // idle | loading | live | error
  const [error, setError] = useState('');
  const [photoMsg, setPhotoMsg] = useState('');
  const [photoOk, setPhotoOk] = useState(false);
  const [faceSeen, setFaceSeen] = useState(false);
  const [myId, setMyId] = useState('');
  const [friendId, setFriendId] = useState('');
  const [inCall, setInCall] = useState(false);
  const [callMsg, setCallMsg] = useState('');

  // Render + tracking loop
  useEffect(() => {
    const stage = new FaceSwapStage(canvasRef.current, videoRef.current);
    stageRef.current = stage;
    let raf, lastT = -1, lm = null;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const tracker = trackerRef.current;
      if (tracker && v.readyState >= 2 && v.currentTime !== lastT) {
        lastT = v.currentTime;
        try {
          lm = tracker.detectForVideo(v, performance.now()).faceLandmarks?.[0] ?? null;
        } catch (err) {
          console.error(err);
        }
        faceSeenRef.current = !!lm;
      }
      stage.render(lm);
    };
    raf = requestAnimationFrame(loop);
    const poll = setInterval(() => setFaceSeen(faceSeenRef.current), 300);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(poll);
      callRef.current?.destroy();
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      trackerRef.current?.close();
      imgTrackerRef.current?.close();
      stage.dispose();
    };
  }, []);

  // "H" toggles call mode
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') setUiHidden((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startCamera = useCallback(async () => {
    setCam('loading');
    setError('');
    try {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); // no mic
      }
      camStreamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play();
      trackerRef.current ??= await createVideoTracker();
      stageRef.current.fit();

      // What the other person receives: the swapped canvas plus your microphone
      const out = canvasRef.current.captureStream(30);
      stream.getAudioTracks().forEach((t) => out.addTrack(t));
      outStreamRef.current = out;

      callRef.current ??= createCallClient({
        getStream: () => outStreamRef.current,
        onId: setMyId,
        onRemote: (s) => {
          remoteRef.current.srcObject = s;
          remoteRef.current.play().catch(() => {});
          setInCall(true);
          setCallMsg('');
        },
        onEnd: () => {
          if (remoteRef.current) remoteRef.current.srcObject = null;
          setInCall(false);
        },
        onError: setCallMsg,
      });
      setCam('live');
    } catch (err) {
      setError(err?.message || 'Could not start the camera.');
      setCam('error');
    }
  }, []);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoOk(false);
    setPhotoMsg('Reading the face in your picture…');
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
      imgTrackerRef.current ??= await createImageTracker();
      const lm = imgTrackerRef.current.detect(c).faceLandmarks?.[0];
      if (!lm) throw new Error('No face found in that picture. Use a clear photo of one face looking at the camera.');
      stageRef.current.setPhoto(c, lm);
      setPhotoOk(true);
      setPhotoMsg('Picture applied.');
    } catch (err) {
      setPhotoMsg(err?.message || 'Could not use that picture.');
    }
  };

  const copyId = () => navigator.clipboard?.writeText(myId);
  const placeCall = () => {
    if (!friendId.trim()) return;
    setCallMsg('Calling…');
    callRef.current?.call(friendId);
  };

  const status =
    cam !== 'live' ? '' : !faceSeen ? 'No face detected. Look at the camera in good light.' : photoOk ? '' : 'Choose a picture to swap your face.';

  return (
    <div className="app">
      <video ref={remoteRef} className={`remote${inCall ? ' on' : ''}`} autoPlay playsInline />
      <canvas ref={canvasRef} className={`local ${inCall ? 'pip' : 'full'}`} />
      {/* hidden source video; kept rendering so decoding never stalls */}
      <video ref={videoRef} className="source" playsInline muted />
      {cam !== 'live' && <p className="empty">Start the camera to begin.</p>}

      <aside className={`panel${uiHidden ? ' closed' : ''}`} aria-hidden={uiHidden}>
        <h1>Face Call</h1>
        <p className="lede">Your face on the call becomes the picture you choose, and follows your head and expressions.</p>

        <label className="btn solid">
          Choose Any Picture
          <input type="file" accept="image/*" onChange={onFile} />
        </label>
        {photoMsg && <p className={`status${photoOk ? '' : ' warn'}`}>{photoMsg}</p>}

        <button className="btn" onClick={startCamera} disabled={cam === 'loading' || cam === 'live'}>
          {cam === 'loading' ? 'Starting…' : cam === 'live' ? 'Camera is on' : 'Start camera'}
        </button>

        {cam === 'live' && (
          <div className="call">
            <p className="label">Your call ID</p>
            <div className="row">
              <code>{myId || '…'}</code>
              <button className="mini" onClick={copyId} disabled={!myId}>Copy</button>
            </div>
            <p className="label">Friend's call ID</p>
            <div className="row">
              <input value={friendId} onChange={(e) => setFriendId(e.target.value)} placeholder="paste their ID" />
              <button className="mini" onClick={placeCall} disabled={!myId}>Call</button>
            </div>
            {inCall && <button className="btn" onClick={() => callRef.current?.hangup()}>Hang up</button>}
            {callMsg && <p className="status warn">{callMsg}</p>}
          </div>
        )}

        <button className="btn" onClick={() => setUiHidden(true)}>Hide UI (Call Mode)</button>
        {status && <p className="status">{status}</p>}
        {error && <p className="status warn">{error}</p>}
        <p className="hint">Press H to hide or show controls.</p>
      </aside>

      <button className={`restore${uiHidden ? ' visible' : ''}`} onClick={() => setUiHidden(false)} tabIndex={uiHidden ? 0 : -1}>
        Show controls
      </button>
    </div>
  );
}

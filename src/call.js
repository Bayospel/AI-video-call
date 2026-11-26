import Peer from 'peerjs';

const code = () => Math.random().toString(36).slice(2, 8);

/** Peer-to-peer call using the free public PeerJS signalling server. */
export function createCallClient({ getStream, onId, onRemote, onEnd, onError }) {
  const peer = new Peer(`fc${code()}`);
  let current = null;

  const attach = (call) => {
    current?.close();
    current = call;
    call.on('stream', onRemote);
    call.on('close', () => { if (current === call) { current = null; onEnd(); } });
    call.on('error', (e) => onError(e.message || String(e)));
  };

  peer.on('open', onId);
  peer.on('error', (e) => onError(e.type === 'peer-unavailable' ? 'Nobody is online with that ID.' : e.message));
  peer.on('call', (call) => { call.answer(getStream()); attach(call); });

  return {
    call(id) { attach(peer.call(id.trim(), getStream())); },
    hangup() { current?.close(); current = null; onEnd(); },
    destroy() { peer.destroy(); },
  };
}

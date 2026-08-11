// GET /api/stream — Server-Sent Events. Auth'd (mounted behind requireAuth, so
// req.tenantId is set); forwards ONLY this tenant's bus events, sends a heartbeat
// comment every config.sseHeartbeatMs, and tears everything down on disconnect.
export function streamHandler({ bus, config }) {
  return function stream(req, res) {
    // Keep the socket open indefinitely and unbuffered.
    if (req.socket && typeof req.socket.setTimeout === 'function') req.socket.setTimeout(0);
    if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
    if (req.socket && typeof req.socket.setKeepAlive === 'function') req.socket.setKeepAlive(true);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell Nginx not to buffer the stream
    });
    res.write(': connected\n\n');
    res.write('retry: 3000\n\n');

    const tenantId = req.tenantId;
    const onEvent = (envelope) => {
      if (!envelope || envelope.tenantId !== tenantId) return; // strict tenant fan-out
      try {
        res.write(`event: ${envelope.type}\n`);
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      } catch {
        /* connection went away between the close event and this write */
      }
    };
    const unsubscribe = bus.subscribe(onEvent);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, config.sseHeartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  };
}

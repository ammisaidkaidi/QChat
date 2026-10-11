export function openSse(res) {
    let closed = false;
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
        if (closed)
            return;
        res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();
    return {
        get closed() {
            return closed;
        },
        send(payload, event) {
            if (closed)
                return;
            const body = JSON.stringify(payload);
            res.write(event ? `event: ${event}\ndata: ${body}\n\n` : `data: ${body}\n\n`);
        },
        comment(text) {
            if (closed)
                return;
            res.write(`: ${text}\n\n`);
        },
        close() {
            if (closed)
                return;
            closed = true;
            clearInterval(heartbeat);
            res.write('event: close\ndata: {}\n\n');
            res.end();
        },
    };
}
//# sourceMappingURL=sse.js.map
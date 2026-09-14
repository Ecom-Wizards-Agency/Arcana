// @ts-check
/* global window, document, performance, PerformanceObserver, URL */
// A classic, parser-blocking asset. Webpack gives this file a content hash;
// the layout carries only its URL, rather than duplicating its body in RSC.
"use strict";
(function installShellFetchActivity() {
    const target = /** @type {Window & { __arcanaShellFetchActivity?: import('./shell-fetch-activity').ShellFetchActivity }} */ (window);
    if (target.__arcanaShellFetchActivity)
        return target.__arcanaShellFetchActivity;
    const originalFetch = window.fetch;
    const listeners = new Set(/** @type {(() => void)[]} */ ([]));
    /** @type {{ url: string; start: number; finish: () => void }[]} */
    const records = [];
    /** @type {import('./shell-fetch-activity').ShellFetchActivity} */
    const activity = {
        pending: 0,
        lastSettledAt: performance.now(),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() {
            window.fetch = originalFetch;
            observer?.disconnect();
            listeners.clear();
            delete target.__arcanaShellFetchActivity;
        },
    };
    const notify = () => listeners.forEach((listener) => listener());
    const begin = () => {
        activity.pending++;
        notify();
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            activity.pending--;
            activity.lastSettledAt = performance.now();
            notify();
        };
    };
    // Resource completion also releases requests whose callers only inspect headers.
    // Body consumers remain counted separately until parsing or stream reads finish.
    const observer = typeof PerformanceObserver === 'undefined' ? undefined : new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            if (/** @type {PerformanceResourceTiming} */ (entry).initiatorType !== 'fetch')
                continue;
            const candidates = records.filter((record) => record.url === entry.name && record.start <= entry.startTime + 1);
            const closest = candidates.sort((a, b) => Math.abs(a.start - entry.startTime) - Math.abs(b.start - entry.startTime))[0];
            if (closest !== undefined) {
                records.splice(records.indexOf(closest), 1);
                closest.finish();
            }
        }
    });
    observer?.observe({ type: 'resource' });
    window.fetch = function (...args) {
        const input = args[0];
        let url;
        try {
            url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, document.baseURI).href;
        }
        catch {
            return originalFetch.apply(this, args);
        }
        const settled = begin();
        const finish = () => {
            const index = records.indexOf(record);
            if (index !== -1)
                records.splice(index, 1);
            settled();
        };
        const record = { url, start: performance.now(), finish };
        records.push(record);
        /** @param {unknown} error @returns {never} */
        const failed = (error) => { finish(); throw error; };
        try {
            return originalFetch.apply(this, args).then((response) => {
                for (const method of /** @type {const} */ (['arrayBuffer', 'blob', 'formData', 'json', 'text'])) {
                    const read = response[method].bind(response);
                    Object.defineProperty(response, method, { configurable: true, value: async () => {
                            const consumed = begin();
                            try {
                                return await read();
                            }
                            finally {
                                consumed();
                                if (observer === undefined) finish();
                            }
                        } });
                }
                const body = response.body;
                if (body !== null) {
                    const getReader = body.getReader.bind(body);
                    Object.defineProperty(body, 'getReader', { configurable: true, value: /** @param {Parameters<typeof getReader>} options */ (...options) => {
                            const reader = getReader(...options);
                            const consumed = begin();
                            const complete = () => { consumed(); if (observer === undefined) finish(); };
                            const read = reader.read.bind(reader);
                            const cancel = reader.cancel.bind(reader);
                            const release = reader.releaseLock.bind(reader);
                            Object.defineProperty(reader, 'read', { value: /** @param {Parameters<typeof read>} options */ async (...options) => {
                                    try {
                                        const result = /** @type {ReadableStreamReadResult<unknown>} */ (await Reflect.apply(read, reader, options));
                                        if (result.done)
                                            complete();
                                        return result;
                                    }
                                    catch (error) {
                                        complete();
                                        throw error;
                                    }
                                } });
                            Object.defineProperty(reader, 'cancel', { value: /** @param {unknown} [reason] */ async (reason) => {
                                    try {
                                        return await cancel(reason);
                                    }
                                    finally {
                                        complete();
                                    }
                                } });
                            Object.defineProperty(reader, 'releaseLock', { value: () => { try {
                                    release();
                                }
                                finally {
                                    complete();
                                } } });
                            return reader;
                        } });
                }
                // Body consumption can settle before the browser publishes the
                // resource's completion. Keep that network record until its
                // observer callback; each body consumer has its own counter.
                if (observer === undefined)
                    finish();
                return response;
            }, failed);
        }
        catch (error) {
            return Promise.reject(error).catch(failed);
        }
    };
    target.__arcanaShellFetchActivity = activity;
    return activity;
})();

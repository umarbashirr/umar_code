import { useCallback, useEffect, useState } from 'react';

const tandem = () => window.tandem;

// The settings file, and the two update checks that hang off it. Main owns
// both; everything here is a mirror that main corrects. Every setter goes
// through main rather than changing local state first, so the file and the
// window can never disagree about what was saved.
export function useSettings() {
  const [data, setData] = useState(() => {
    try { return tandem().settings.snapshot(); } catch { return null; }
  });

  useEffect(() => {
    tandem().settings.get().then(setData).catch(() => {});
    return tandem().settings.onChanged((next) => { if (next) setData(next); });
  }, []);

  const set = useCallback(async (partial) => {
    const next = await tandem().settings.set(partial);
    if (next) setData(next);
    return next;
  }, []);

  const reset = useCallback(async () => {
    const next = await tandem().settings.reset();
    if (next) setData(next);
    return next;
  }, []);

  return { settings: data, set, reset };
}

const NO_UPDATES = {
  app: { current: '', latest: null, behind: false },
  claude: { running: null, bundled: null, system: null, latest: null, behind: false, canSwitch: false },
  kind: 'dev',
  checkedAt: null,
  error: null,
};

export function useUpdates() {
  const [info, setInfo] = useState(NO_UPDATES);
  const [checking, setChecking] = useState(false);
  // { received, total, done } while a file is coming down, then the path it
  // landed at once it is here.
  const [progress, setProgress] = useState(null);
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    tandem().updates.info().then((v) => v && setInfo(v)).catch(() => {});
    const offChanged = tandem().updates.onChanged((v) => { if (v) setInfo(v); });
    const offProgress = tandem().updates.onProgress((p) => setProgress(p));
    return () => { offChanged?.(); offProgress?.(); };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const next = await tandem().updates.check();
      if (next) setInfo(next);
      return next;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  // A quarter of a gigabyte over a home connection, so this is deliberately two
  // steps: fetch, then hand the file to the installer when the person says so.
  const download = useCallback(async () => {
    setError(null);
    setProgress({ received: 0, total: info.app?.asset?.size || 0, done: false });
    const res = await tandem().updates.download();
    setProgress(null);
    if (res?.error) { setError(res.error); return null; }
    setFile(res.path);
    return res.path;
  }, [info]);

  const install = useCallback(async (target) => {
    const res = await tandem().updates.install(target || file);
    if (res?.error) setError(res.error);
    return res;
  }, [file]);

  return {
    ...info,
    checking,
    progress,
    file,
    error: error || info.error,
    check,
    download,
    install,
    openPage: () => tandem().updates.openPage(),
  };
}

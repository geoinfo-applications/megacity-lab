// Low-memory devices and the guard against reloading into the build that just killed the page.
const BUILD_MARK = 'megacity-build-started';
const CRASH_WINDOW_MS = 5 * 60 * 1000;

function forcedTier() {
    return new URLSearchParams(location.search).get('lite');
}

// iOS kills a tab long before a desktop browser would, and Safari does not report device memory.
export function isLowMemoryDevice() {
    const forced = forcedTier();
    if (forced !== null) return forced !== '0';
    return window.matchMedia('(pointer: coarse)').matches && !(navigator.deviceMemory >= 8);
}

export const TEXTURES = isLowMemoryDevice() ? { ground: 4096, glow: 2048 } : { ground: 8192, glow: 4096 };

function readMark() {
    try {
        return Number(localStorage.getItem(BUILD_MARK));
    } catch {
        return 0;
    }
}

function writeMark(value) {
    try {
        if (value) localStorage.setItem(BUILD_MARK, String(value));
        else localStorage.removeItem(BUILD_MARK);
    } catch {
        return;
    }
}

export function markBuildStarted() {
    writeMark(Date.now());
}

export function markBuildEnded() {
    writeMark(0);
}

export function lastBuildDied() {
    const started = readMark();
    writeMark(0);
    return started > 0 && Date.now() - started < CRASH_WINDOW_MS;
}

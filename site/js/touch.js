// Touch gestures on the map: one finger pans, two fingers pinch to zoom, twist to turn and slide to tilt.
const MIN_DISTANCE = 120, MAX_DISTANCE = 90000;
const TILT_PER_PIXEL = 0.004;
const MIN_TILT_SINE = 0.25;

function twoFingers(pointers) {
    const [a, b] = pointers.values();
    return {
        spread: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        middleY: (a.y + b.y) / 2,
    };
}

function shortestTurn(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function installTouch(canvas, camera, { moveTarget, onTouch }) {
    const pointers = new Map();
    let pair = null;

    // Keeps the ground under the finger: one pixel covers this much at the target, and tilt stretches it along the view.
    function pan(dx, dy) {
        const perPixel = 2 * camera.distance * Math.tan(camera.fov / 2) / canvas.clientHeight;
        moveTarget(dx * perPixel, dy * perPixel / Math.max(Math.sin(camera.pitch), MIN_TILT_SINE));
    }

    function release(ev) {
        pointers.delete(ev.pointerId);
        pair = pointers.size === 2 ? twoFingers(pointers) : null;
    }

    canvas.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType !== 'touch') return;
        canvas.setPointerCapture(ev.pointerId);
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        camera.anim = null;
        pair = pointers.size === 2 ? twoFingers(pointers) : null;
        onTouch();
    });
    canvas.addEventListener('pointermove', (ev) => {
        const pointer = pointers.get(ev.pointerId);
        if (!pointer) return;
        const dx = ev.clientX - pointer.x, dy = ev.clientY - pointer.y;
        pointer.x = ev.clientX;
        pointer.y = ev.clientY;
        if (pointers.size === 1) {
            pan(dx, dy);
        } else if (pair) {
            const next = twoFingers(pointers);
            camera.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, camera.distance * pair.spread / next.spread));
            camera.yaw += shortestTurn(pair.angle, next.angle);
            camera.pitch = Math.max(0.03, Math.min(1.5, camera.pitch + (next.middleY - pair.middleY) * TILT_PER_PIXEL));
            pair = next;
            moveTarget(0, 0);
        }
    });
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
}

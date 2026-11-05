// Solar position (NOAA spreadsheet algorithm, ~0.01 deg) and LV95 -> WGS84 (swisstopo approximate formulas, ~1 m).

export function lv95ToWgs84(e, n) {
    const y = (e - 2600000) / 1e6;
    const x = (n - 1200000) / 1e6;
    const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
    const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
    return { lat: lat * 100 / 36, lon: lon * 100 / 36 };
}

const rad = Math.PI / 180;

// date: JS Date (UTC instant). Returns azimuth from north clockwise and elevation, degrees.
export function solarPosition(date, lat, lon) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const t = (jd - 2451545) / 36525;
    const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const c = Math.sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * rad) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * rad) * 0.000289;
    const trueLong = l0 + c;
    const omega = 125.04 - 1934.136 * t;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * rad);
    const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
    const yv = Math.tan(eps * rad / 2) ** 2;
    const eqTime = 4 / rad * (yv * Math.sin(2 * l0 * rad) - 2 * e * Math.sin(m * rad) + 4 * e * yv * Math.sin(m * rad) * Math.cos(2 * l0 * rad)
        - 0.5 * yv * yv * Math.sin(4 * l0 * rad) - 1.25 * e * e * Math.sin(2 * m * rad));
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const trueSolar = (minutes + eqTime + 4 * lon + 1440) % 1440;
    let hourAngle = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180;
    const latR = lat * rad;
    const cosZen = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle * rad);
    const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen)));
    let az = Math.acos(Math.min(1, Math.max(-1, (Math.sin(latR) * Math.cos(zenith) - Math.sin(decl)) / (Math.cos(latR) * Math.sin(zenith))))) / rad;
    az = hourAngle > 0 ? (az + 180) % 360 : (540 - az) % 360;
    return { azimuth: az, elevation: 90 - zenith / rad };
}

// World direction towards the sun: X east, Y up, Z south.
export function sunVector(azimuth, elevation) {
    const a = azimuth * rad, e = elevation * rad;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

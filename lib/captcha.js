// 纯 JS 光栅绘图 + PNG 编码（Vercel Edge 环境，无原生依赖）
// 用途：把验证题的答案（口令 / 序列 / 计数 / 找不同）只画进图片，
// 使脚本无法从消息文本或按钮文本里读到答案。
//
// PNG 编码：手写 CRC32 + chunk 组装；IDAT 用 CompressionStream("deflate")
// 产出的 zlib 流（PNG 要求的正是 zlib 格式）。

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

async function deflateZlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- 5x7 点阵字体（A-Z、0-9） ----------
const FONT_ROWS = {
    A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
    D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
    H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
    J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
    O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
    X: ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".#.#.", "#...#"],
    Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    2: [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
    3: [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
    4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
    7: ["#####", "....#", "...#.", "..#..", "..#..", "..#..", "..#.."],
    8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
    "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."]
};
// 编译为行位图（每行一个 5 位掩码，bit4 为最左列）
const FONT = {};
for (const [ch, rows] of Object.entries(FONT_ROWS)) {
    FONT[ch] = rows.map((row) => {
        let bits = 0;
        for (let i = 0; i < 5; i++) if (row[i] === "#") bits |= 1 << (4 - i);
        return bits;
    });
}

// ---------- 像素画布 ----------
function randInt(min, max) {
    // 仅用于视觉随机（抖动/配色/噪点），与答案无关，无需密码学随机
    return min + Math.floor(Math.random() * (max - min));
}

function createCanvas(width, height) {
    const data = new Uint8ClampedArray(width * height * 3);
    const ctx = {
        width,
        height,
        data,
        fillAll(color) {
            for (let i = 0; i < width * height; i++) {
                data[i * 3] = color[0];
                data[i * 3 + 1] = color[1];
                data[i * 3 + 2] = color[2];
            }
        },
        setPixel(x, y, color) {
            x |= 0;
            y |= 0;
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            const o = (y * width + x) * 3;
            data[o] = color[0];
            data[o + 1] = color[1];
            data[o + 2] = color[2];
        },
        fillRect(x, y, w, h, color) {
            const x0 = Math.max(0, Math.floor(x));
            const y0 = Math.max(0, Math.floor(y));
            const x1 = Math.min(width, Math.ceil(x + w));
            const y1 = Math.min(height, Math.ceil(y + h));
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) ctx.setPixel(xx, yy, color);
            }
        },
        fillCircle(cx, cy, r, color) {
            const r2 = r * r;
            for (let y = Math.floor(cy - r); y <= cy + r; y++) {
                for (let x = Math.floor(cx - r); x <= cx + r; x++) {
                    const dx = x - cx;
                    const dy = y - cy;
                    if (dx * dx + dy * dy <= r2) ctx.setPixel(x, y, color);
                }
            }
        },
        fillTriangle(x1, y1, x2, y2, x3, y3, color) {
            const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
            if (d === 0) return;
            const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2, x3)));
            const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3)));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2, y3)));
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const w1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
                    const w2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
                    const w3 = 1 - w1 - w2;
                    if (w1 >= -0.001 && w2 >= -0.001 && w3 >= -0.001) ctx.setPixel(x, y, color);
                }
            }
        },
        // 粗线：沿线段采样并盖圆点
        line(x1, y1, x2, y2, color, widthPx = 2) {
            const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
            const r = Math.max(1, widthPx / 2);
            for (let i = 0; i <= steps; i++) {
                const x = x1 + ((x2 - x1) * i) / steps;
                const y = y1 + ((y2 - y1) * i) / steps;
                ctx.fillCircle(x, y, r, color);
            }
        },
        drawChar(ch, x, y, scale, color) {
            const glyph = FONT[ch] || FONT["?"];
            for (let row = 0; row < 7; row++) {
                for (let col = 0; col < 5; col++) {
                    if (glyph[row] & (1 << (4 - col))) {
                        ctx.fillRect(x + col * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
        },
        textWidth(str, scale, spacing) {
            return str.length ? str.length * 5 * scale + (str.length - 1) * spacing : 0;
        },
        drawText(str, x, y, scale, color, spacing = scale) {
            let cx = x;
            for (const ch of str) {
                ctx.drawChar(ch, cx, y, scale, color);
                cx += 5 * scale + spacing;
            }
        },
        noise(count, color) {
            for (let i = 0; i < count; i++) {
                const s = randInt(1, 3);
                ctx.fillRect(randInt(0, width), randInt(0, height), s, s, color);
            }
        }
    };
    return ctx;
}

// ---------- PNG 编码 ----------
// makePng(width, height, drawFn)：drawFn(ctx) 在浅色底上作画，返回 PNG 字节
export async function makePng(width, height, drawFn) {
    const ctx = createCanvas(width, height);
    ctx.fillAll([247, 248, 250]);
    drawFn(ctx);

    const stride = width * 3;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // 每行 filter type 0
        raw.set(ctx.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const idat = await deflateZlib(raw);

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth 8
    ihdr[9] = 2; // color type 2 = RGB

    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", idat),
        pngChunk("IEND", new Uint8Array(0))
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const png = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        png.set(p, off);
        off += p.length;
    }
    return png;
}

// ---------- 出题渲染 ----------
const INK_COLORS = [
    [30, 41, 59],   // 深灰蓝
    [29, 78, 216],  // 蓝
    [185, 28, 28],  // 红
    [4, 120, 87],   // 绿
    [126, 34, 206]  // 紫
];
const LINE_COLOR = [203, 213, 225];
const NOISE_COLOR = [148, 163, 184];

// 口令 / 序列图：字符逐字 Y 抖动 + 逐字变色 + 干扰线 + 噪点
export async function renderCodeImage(code) {
    const str = String(code || "");
    return makePng(480, 200, (ctx) => {
        for (let i = 0; i < 4; i++) {
            ctx.line(randInt(0, 90), randInt(0, 200), randInt(390, 480), randInt(0, 200), LINE_COLOR, 3);
        }
        const scale = 13;
        const spacing = 16;
        const totalW = ctx.textWidth(str, scale, spacing);
        let x = Math.round((480 - totalW) / 2);
        const baseY = Math.round((200 - 7 * scale) / 2);
        for (const ch of str) {
            const color = INK_COLORS[randInt(0, INK_COLORS.length)];
            ctx.drawChar(ch, x, baseY + randInt(-9, 10), scale, color);
            x += 5 * scale + spacing;
        }
        ctx.noise(140, NOISE_COLOR);
    });
}

// 计数图：circles 个蓝色圆形 + squares 个橙色方形，抖动网格分布（互不重叠）
export async function renderCountImage({ circles = 0, squares = 0 } = {}) {
    return makePng(480, 360, (ctx) => {
        for (let i = 0; i < 3; i++) {
            ctx.line(randInt(0, 120), randInt(0, 360), randInt(360, 480), randInt(0, 360), LINE_COLOR, 3);
        }
        const items = [
            ...new Array(circles).fill("circle"),
            ...new Array(squares).fill("square")
        ];
        for (let i = items.length - 1; i > 0; i--) {
            const j = randInt(0, i + 1);
            [items[i], items[j]] = [items[j], items[i]];
        }
        const cols = 4;
        const cellW = 120;
        const cellH = 90;
        const r = 24;
        items.forEach((shape, idx) => {
            const cx = (idx % cols) * cellW + cellW / 2 + randInt(-16, 17);
            const cy = Math.floor(idx / cols) * cellH + cellH / 2 + randInt(-10, 11);
            if (shape === "circle") ctx.fillCircle(cx, cy, r, [37, 99, 235]);
            else ctx.fillRect(cx - r, cy - r, r * 2, r * 2, [234, 88, 12]);
        });
        ctx.noise(80, NOISE_COLOR);
    });
}

const SHAPE_DRAW = {
    circle: (ctx, cx, cy, r, color) => ctx.fillCircle(cx, cy, r, color),
    square: (ctx, cx, cy, r, color) => ctx.fillRect(cx - r, cy - r, r * 2, r * 2, color),
    triangle: (ctx, cx, cy, r, color) => ctx.fillTriangle(cx, cy - r, cx - r, cy + r, cx + r, cy + r, color)
};

// 找不同图：4×4 同色图形阵列，oddIndex 处为 odd 形状，其余为 base 形状
export async function renderGridImage({ base = "circle", odd = "triangle", oddIndex = 0 } = {}) {
    return makePng(400, 400, (ctx) => {
        for (let i = 0; i <= 4; i++) {
            ctx.fillRect(i * 100 - 1, 0, 2, 400, [226, 232, 240]);
            ctx.fillRect(0, i * 100 - 1, 400, 2, [226, 232, 240]);
        }
        const color = [51, 65, 85];
        for (let i = 0; i < 16; i++) {
            const cx = (i % 4) * 100 + 50 + randInt(-4, 5);
            const cy = Math.floor(i / 4) * 100 + 50 + randInt(-4, 5);
            const draw = SHAPE_DRAW[i === oddIndex ? odd : base] || SHAPE_DRAW.circle;
            draw(ctx, cx, cy, 28, color);
        }
        ctx.noise(50, NOISE_COLOR);
    });
}

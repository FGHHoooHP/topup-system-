require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const { parseSlip } = require("./services/slipParser");

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;

const REQUIRED_RECEIVER_NAME =
    "ด.ช. ชลชาติ";

const REQUIRED_RECEIVER_NUMBER =
    "2202587596";

/* =========================
   UPLOAD
========================= */

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 4 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const allowed = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif"
        ];

        if (!allowed.includes(file.mimetype)) {
            return cb(
                new Error(
                    "รองรับเฉพาะ JPG, PNG, WEBP, GIF"
                )
            );
        }

        cb(null, true);
    }
});

/* =========================
   DATABASE
========================= */

const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL,

    ssl:
        process.env.NODE_ENV === "production"
            ? {
                  rejectUnauthorized: false
              }
            : false
});

app.use(cors());
app.use(express.json());

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "index.html")
    );
});

/* =========================
   DATABASE INIT
========================= */

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(32) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance NUMERIC(12,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            token_hash TEXT UNIQUE NOT NULL,

            expires_at TIMESTAMP NOT NULL,

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,

            user_id INTEGER NOT NULL
                REFERENCES users(id)
                ON DELETE CASCADE,

            amount NUMERIC(12,2) NOT NULL,

            transaction_id TEXT UNIQUE,

            status VARCHAR(20)
                NOT NULL
                DEFAULT 'PENDING',

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS
            qr_started_at TIMESTAMPTZ;

        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS
            expires_at TIMESTAMPTZ;

        CREATE INDEX IF NOT EXISTS
        idx_sessions_token
        ON sessions(token_hash);

        CREATE INDEX IF NOT EXISTS
        idx_payments_user
        ON payments(user_id);

        CREATE INDEX IF NOT EXISTS
        idx_payments_transaction
        ON payments(transaction_id);
    `);

    console.log("Database ready");
}

/* =========================
   HELPERS
========================= */
function parseSlipDateTime(
    dateText,
    timeText
) {
    const months = {
        "ม.ค.": 0,
        "ก.พ.": 1,
        "มี.ค.": 2,
        "เม.ย.": 3,
        "พ.ค.": 4,
        "มิ.ย.": 5,
        "ก.ค.": 6,
        "ส.ค.": 7,
        "ก.ย.": 8,
        "ต.ค.": 9,
        "พ.ย.": 10,
        "ธ.ค.": 11
    };

    const dateMatch =
        String(dateText || "")
            .trim()
            .match(
                /^(\d{1,2})\s+(\S+)\s+(\d{2,4})$/
            );

    const timeMatch =
        String(timeText || "")
            .trim()
            .match(
                /^(\d{1,2}):(\d{2})$/
            );

    if (
        !dateMatch ||
        !timeMatch
    ) {
        return null;
    }

    const day =
        Number(dateMatch[1]);

    const monthName =
        dateMatch[2];

    const month =
        months[monthName];

    let year =
        Number(dateMatch[3]);

    const hour =
        Number(timeMatch[1]);

    const minute =
        Number(timeMatch[2]);

    if (
        month === undefined ||
        !Number.isInteger(day) ||
        !Number.isInteger(year) ||
        !Number.isInteger(hour) ||
        !Number.isInteger(minute)
    ) {
        return null;
    }

    /*
     * สลิปไทย:
     * 69 = พ.ศ. 2569
     */

    if (year < 100) {
        year += 2500;
    }

    /*
     * พ.ศ. → ค.ศ.
     */

    if (year >= 2400) {
        year -= 543;
    }

    if (
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        return null;
    }

    /*
     * เวลาในสลิป K PLUS
     * เป็นเวลาไทย UTC+7
     */

    const timestamp =
        Date.UTC(
            year,
            month,
            day,
            hour - 7,
            minute,
            0,
            0
        );

    const result =
        new Date(timestamp);

    /*
     * เช็กวันที่ผิด เช่น 32 ต.ค.
     */

    const check =
        new Date(
            timestamp +
            7 * 60 * 60 * 1000
        );

    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute
    ) {
        return null;
    }

    return result;
}
function normalizeReceiverText(value) {
    return String(value || "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
}

function isRequiredReceiverName(value) {
    const text =
        normalizeReceiverText(value);

    return /^ด\s*\.?\s*ช\s*\.?\s*ชลชาติ(?:\s|$)/u
        .test(text);
}

function hasRequiredReceiverNumber(
    rawText
) {
    const lines =
        String(rawText || "")
            .split(/\r?\n/)
            .map(
                line =>
                    normalizeReceiverText(
                        line
                    )
            )
            .filter(Boolean);

    const receiverLineIndex =
        lines.findIndex(
            line =>
                isRequiredReceiverName(
                    line
                )
        );

    if (receiverLineIndex < 0) {
        return false;
    }

    /*
     * ตรวจเลขเฉพาะบริเวณข้อมูลผู้รับ
     * 1 บรรทัดก่อนชื่อ ถึง 4 บรรทัดหลังชื่อ
     * รองรับเลขที่มีขีด/เว้นวรรค เช่น
     * 220-2-58759-6
     */

    const start =
        Math.max(
            0,
            receiverLineIndex - 1
        );

    const end =
        Math.min(
            lines.length,
            receiverLineIndex + 5
        );

    for (
        let i = start;
        i < end;
        i++
    ) {
        const digits =
            lines[i]
                .replace(/\D/g, "");

        if (
            digits.includes(
                REQUIRED_RECEIVER_NUMBER
            )
        ) {
            return true;
        }
    }

    return false;
}

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function createToken() {
    return crypto
        .randomBytes(48)
        .toString("hex");
}

function getCookie(req, name) {
    const header =
        req.headers.cookie;

    if (!header) {
        return null;
    }

    const cookies = header
        .split(";")
        .map(
            item =>
                item.trim()
        );

    const cookie =
        cookies.find(
            item =>
                item.startsWith(
                    `${name}=`
                )
        );

    if (!cookie) {
        return null;
    }

    return decodeURIComponent(
        cookie.substring(
            name.length + 1
        )
    );
}

function setSessionCookie(
    res,
    token
) {
    const maxAge =
        SESSION_DAYS *
        24 *
        60 *
        60;

    const secure =
        process.env.NODE_ENV ===
        "production";

    res.setHeader(
        "Set-Cookie",
        [
            `session=${encodeURIComponent(token)}`,
            "Path=/",
            `Max-Age=${maxAge}`,
            "HttpOnly",
            "SameSite=Lax",
            secure
                ? "Secure"
                : ""
        ]
            .filter(Boolean)
            .join("; ")
    );
}

function clearSessionCookie(res) {
    res.setHeader(
        "Set-Cookie",
        "session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    );
}

/* =========================
   AUTH MIDDLEWARE
========================= */

async function auth(
    req,
    res,
    next
) {
    try {
        const token =
            getCookie(
                req,
                "session"
            );

        if (!token) {
            return res
                .status(401)
                .json({
                    error:
                        "กรุณาเข้าสู่ระบบ"
                });
        }

        const tokenHash =
            hashToken(token);

        const result =
            await pool.query(
                `
                SELECT
                    sessions.id
                        AS session_id,

                    sessions.expires_at,

                    users.id,
                    users.username,
                    users.balance

                FROM sessions

                INNER JOIN users
                    ON users.id =
                       sessions.user_id

                WHERE
                    sessions.token_hash = $1

                AND
                    sessions.expires_at
                    > NOW()
                `,
                [tokenHash]
            );

        if (
            !result.rows.length
        ) {
            clearSessionCookie(
                res
            );

            return res
                .status(401)
                .json({
                    error:
                        "Session หมดอายุ"
                });
        }

        req.user =
            result.rows[0];

        req.sessionId =
            result.rows[0]
                .session_id;

        next();

    } catch (error) {
        console.error(
            "AUTH ERROR:",
            error
        );

        res
            .status(500)
            .json({
                error:
                    "ตรวจสอบ Session ไม่สำเร็จ"
            });
    }
}

/* =========================
   HEALTH
========================= */

app.get(
    "/api/health",
    (req, res) => {
        res.json({
            status: "online"
        });
    }
);

/* =========================
   REGISTER
========================= */

app.post(
    "/api/auth/register",

    async (req, res) => {
        try {
            let {
                username,
                password
            } = req.body;

            username =
                String(
                    username || ""
                )
                    .trim()
                    .toLowerCase();

            password =
                String(
                    password || ""
                );

            if (
                !/^[a-zA-Z0-9_]{3,32}$/.test(
                    username
                )
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Username ต้องมี 3-32 ตัว และใช้ A-Z, a-z, 0-9, _ เท่านั้น"
                    });
            }

            if (
                password.length < 6
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "รหัสผ่านต้องมีอย่างน้อย 6 ตัว"
                    });
            }

            const exists =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE username = $1
                    `,
                    [username]
                );

            if (
                exists.rows.length
            ) {
                return res
                    .status(409)
                    .json({
                        error:
                            "Username นี้ถูกใช้แล้ว"
                    });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                await pool.query(
                    `
                    INSERT INTO users (
                        username,
                        password_hash
                    )

                    VALUES (
                        $1,
                        $2
                    )

                    RETURNING
                        id,
                        username,
                        balance,
                        created_at
                    `,
                    [
                        username,
                        passwordHash
                    ]
                );

            res.status(201).json({
                success: true,

                message:
                    "สมัครสมาชิกสำเร็จ",

                user:
                    result.rows[0]
            });

        } catch (error) {
            console.error(
                "REGISTER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "สมัครสมาชิกไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   LOGIN
========================= */

app.post(
    "/api/auth/login",

    async (req, res) => {
        try {
            let {
                username,
                password
            } = req.body;

            username =
                String(
                    username || ""
                )
                    .trim()
                    .toLowerCase();

            password =
                String(
                    password || ""
                );

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE username = $1
                    `,
                    [username]
                );

            if (
                !result.rows.length
            ) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Username หรือ Password ไม่ถูกต้อง"
                    });
            }

            const user =
                result.rows[0];

            const valid =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );

            if (!valid) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Username หรือ Password ไม่ถูกต้อง"
                    });
            }

            const token =
                createToken();

            const tokenHash =
                hashToken(token);

            await pool.query(
                `
                INSERT INTO sessions (
                    user_id,
                    token_hash,
                    expires_at
                )

                VALUES (
                    $1,
                    $2,
                    NOW() +
                    INTERVAL '30 days'
                )
                `,
                [
                    user.id,
                    tokenHash
                ]
            );

            setSessionCookie(
                res,
                token
            );

            res.json({
                success: true,

                message:
                    "เข้าสู่ระบบสำเร็จ",

                user: {
                    id:
                        user.id,

                    username:
                        user.username,

                    balance:
                        Number(
                            user.balance
                        )
                }
            });

        } catch (error) {
            console.error(
                "LOGIN ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "เข้าสู่ระบบไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   CURRENT USER
========================= */

app.get(
    "/api/auth/me",

    auth,

    (req, res) => {
        res.json({
            success: true,

            user: {
                id:
                    req.user.id,

                username:
                    req.user.username,

                balance:
                    Number(
                        req.user.balance
                    )
            }
        });
    }
);

/* =========================
   LOGOUT
========================= */

app.post(
    "/api/auth/logout",

    async (req, res) => {
        try {
            const token =
                getCookie(
                    req,
                    "session"
                );

            if (token) {
                await pool.query(
                    `
                    DELETE FROM sessions
                    WHERE token_hash = $1
                    `,
                    [
                        hashToken(token)
                    ]
                );
            }

            clearSessionCookie(
                res
            );

            res.json({
                success: true,
                message:
                    "ออกจากระบบแล้ว"
            });

        } catch (error) {
            console.error(
                "LOGOUT ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "ออกจากระบบไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   BALANCE
========================= */

app.get(
    "/api/balance",

    auth,

    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE id = $1
                    `,
                    [
                        req.user.id
                    ]
                );

            res.json({
                success: true,

                balance:
                    Number(
                        result.rows[0]
                            ?.balance || 0
                    )
            });

        } catch (error) {
            console.error(
                "BALANCE ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "โหลดยอดเงินไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   RECEIVER
========================= */

app.get(
    "/api/receiver",

    (req, res) => {
        res.json({
            success: true,

            bank:
                "KBank",

            account:
                process.env
                    .RECEIVER_ACCOUNT ||
                "",

            name:
                process.env
                    .RECEIVER_NAME ||
                ""
        });
    }
);

/* =========================
   QR
========================= */

app.get(
    "/api/qr",

    (req, res) => {
        const qr =
            process.env
                .RECEIVER_QR_URL;

        if (!qr) {
            return res
                .status(503)
                .json({
                    error:
                        "ยังไม่ได้ตั้งค่า QR รับเงิน"
                });
        }

        res.json({
            success: true,

            bank:
                "KBank",

            account:
                process.env
                    .RECEIVER_ACCOUNT ||
                "",

            name:
                process.env
                    .RECEIVER_NAME ||
                "",

            qr
        });
    }
);

/* =========================
   CREATE TOPUP
========================= */

app.post(
    "/api/topup",

    auth,

    async (req, res) => {
        try {
            const amount =
                Number(
                    req.body.amount
                );

            if (
                !Number.isFinite(
                    amount
                ) ||
                amount <= 0
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "จำนวนเงินไม่ถูกต้อง"
                    });
            }

            if (
                amount > 1000000
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "จำนวนเงินเกินกำหนด"
                    });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO payments (
                        user_id,
                        amount,
                        status,
                        qr_started_at,
                        expires_at
                    )

                    VALUES (
                        $1,
                        $2,
                        'PENDING',
                        NOW(),
                        NOW() + INTERVAL '5 minutes'
                    )

                    RETURNING
                        id,
                        amount,
                        status,
                        created_at,
                        qr_started_at,
                        expires_at,
                        clock_timestamp()
                            AS server_now
                    `,
                    [
                        req.user.id,
                        amount
                    ]
                );

            res.json({
                success: true,

                payment:
                    result.rows[0],

                qrUrl:
                    process.env
                        .RECEIVER_QR_URL
            });

        } catch (error) {
            console.error(
                "TOPUP ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "สร้างรายการเติมเงินไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   VERIFY SLIP
========================= */

app.post(
    "/api/verify-slip",
    auth,
    upload.single("slip"),

    async (req, res) => {
        try {

            if (!req.file) {
                return res.status(400).json({
                    error:
                        "กรุณาเลือกสลิป"
                });
            }

            const paymentId =
                Number(
                    req.body.paymentId
                );

            if (
                !Number.isInteger(
                    paymentId
                ) ||
                paymentId <= 0
            ) {
                return res.status(400).json({
                    error:
                        "Payment ID ไม่ถูกต้อง"
                });
            }

            /*
             * ใช้เวลาจาก PostgreSQL Server
             * ไม่ใช้เวลาจากเครื่องผู้ใช้
             */

            const paymentResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        user_id,
                        amount,
                        transaction_id,
                        status,
                        created_at,
                        qr_started_at,
                        expires_at,
                        clock_timestamp()
                            AS server_now

                    FROM payments

                    WHERE id = $1
                    AND user_id = $2
                    `,
                    [
                        paymentId,
                        req.user.id
                    ]
                );

            if (
                !paymentResult.rows.length
            ) {
                return res.status(404).json({
                    error:
                        "ไม่พบรายการเติมเงิน"
                });
            }

            const payment =
                paymentResult.rows[0];

            if (
                payment.status !==
                "PENDING"
            ) {
                return res.status(409).json({
                    error:
                        "รายการนี้ถูกตรวจสอบไปแล้ว"
                });
            }

            /*
             * รายการเก่าที่สร้างก่อนระบบ 5 นาที
             * จะไม่มี qr_started_at/expires_at
             */

            if (
                !payment.qr_started_at ||
                !payment.expires_at
            ) {
                return res.status(410).json({
                    error:
                        "รายการนี้ไม่มีเวลา QR กรุณาสร้างรายการใหม่"
                });
            }

            const qrStartedAt =
                new Date(
                    payment.qr_started_at
                );

            const expiresAt =
                new Date(
                    payment.expires_at
                );

            const serverNow =
                new Date(
                    payment.server_now
                );

            if (
                Number.isNaN(
                    qrStartedAt.getTime()
                ) ||
                Number.isNaN(
                    expiresAt.getTime()
                ) ||
                Number.isNaN(
                    serverNow.getTime()
                )
            ) {
                throw new Error(
                    "เวลา QR ในระบบไม่ถูกต้อง"
                );
            }

            /*
             * ต้องส่งเข้าระบบภายใน 5 นาทีจริง
             */

            if (
                serverNow.getTime() >
                expiresAt.getTime()
            ) {
                await pool.query(
                    `
                    UPDATE payments

                    SET status = 'EXPIRED'

                    WHERE id = $1
                    AND user_id = $2
                    AND status = 'PENDING'
                    `,
                    [
                        paymentId,
                        req.user.id
                    ]
                );

                return res.status(410).json({
                    error:
                        "QR หมดอายุ 5 นาทีแล้ว กรุณาสร้างรายการใหม่"
                });
            }

            console.log("");
            console.log(
                "========================"
            );
            console.log(
                "กำลัง OCR สลิป"
            );
            console.log(
                "Payment ID:",
                paymentId
            );
            console.log(
                "File:",
                req.file.originalname
            );
            console.log(
                "QR Start:",
                qrStartedAt.toISOString()
            );
            console.log(
                "QR Expire:",
                expiresAt.toISOString()
            );
            console.log(
                "Server Now:",
                serverNow.toISOString()
            );
            console.log(
                "========================"
            );

            const slip =
                await parseSlip(
                    req.file.buffer
                );

            console.log(
                "OCR RESULT:",
                slip
            );

            /*
             * RECEIVER
             *
             * ผู้รับต้องเป็น:
             * ด.ช. ชลชาติ
             * เลข 2202587596
             */

            if (
                !isRequiredReceiverName(
                    slip.receiver
                )
            ) {
                return res.status(400).json({
                    error:
                        "ผู้รับไม่ถูกต้อง ต้องเป็น ด.ช. ชลชาติ"
                });
            }

            if (
                !hasRequiredReceiverNumber(
                    slip.raw_text
                )
            ) {
                return res.status(400).json({
                    error:
                        "เลขผู้รับไม่ถูกต้อง ต้องเป็น 2202587596"
                });
            }

            console.log(
                "Receiver verified:",
                REQUIRED_RECEIVER_NAME,
                REQUIRED_RECEIVER_NUMBER
            );

            /*
             * SLIP DATE / TIME
             *
             * slipParser.js ของระบบคืน:
             * date เช่น "7 ต.ค. 69"
             * time เช่น "10:23"
             */

            if (
                !slip.date ||
                !slip.time
            ) {
                return res.status(400).json({
                    error:
                        "ไม่สามารถอ่านวันที่หรือเวลาจากสลิปได้"
                });
            }

            const slipDateTime =
                parseSlipDateTime(
                    slip.date,
                    slip.time
                );

            if (!slipDateTime) {
                return res.status(400).json({
                    error:
                        "วันที่หรือเวลาในสลิปไม่ถูกต้อง"
                });
            }

            /*
             * สลิป OCR มีเวลาแค่ HH:MM
             * จึงเทียบในระดับนาที
             */

            const qrStartMinute =
                Math.floor(
                    qrStartedAt.getTime() /
                    60000
                );

            const qrExpireMinute =
                Math.floor(
                    expiresAt.getTime() /
                    60000
                );

            const serverNowMinute =
                Math.floor(
                    serverNow.getTime() /
                    60000
                );

            const slipMinute =
                Math.floor(
                    slipDateTime.getTime() /
                    60000
                );

            /*
             * สลิปต้องเกิดหลังเปิด QR
             */

            if (
                slipMinute <
                qrStartMinute
            ) {
                return res.status(400).json({
                    error:
                        "สลิปนี้เก่ากว่าเวลาที่เปิด QR"
                });
            }

            /*
             * เวลาสลิปต้องไม่เกินช่วง 5 นาที
             */

            if (
                slipMinute >
                qrExpireMinute
            ) {
                return res.status(400).json({
                    error:
                        "เวลาสลิปเกินช่วง 5 นาทีของ QR"
                });
            }

            /*
             * เวลาบนสลิปต้องไม่อยู่ในอนาคต
             * เมื่อเทียบกับเวลาจริงของ Server
             */

            if (
                slipMinute >
                serverNowMinute
            ) {
                return res.status(400).json({
                    error:
                        "เวลาบนสลิปไม่ตรงกับเวลาปัจจุบันของระบบ"
                });
            }

            const transactionId =
                String(
                    slip.transaction_id ||
                    ""
                )
                    .trim()
                    .toUpperCase();

            if (
                !/^[A-Z0-9]{15,30}$/.test(
                    transactionId
                )
            ) {
                return res.status(400).json({
                    error:
                        "ไม่สามารถอ่านเลขที่รายการจากสลิปได้"
                });
            }

            const slipAmount =
                Number(
                    slip.amount
                );

            if (
                !Number.isFinite(
                    slipAmount
                )
            ) {
                return res.status(400).json({
                    error:
                        "ไม่สามารถอ่านจำนวนเงินจากสลิปได้"
                });
            }

            const paymentAmount =
                Number(
                    payment.amount
                );

            if (
                !Number.isFinite(
                    paymentAmount
                )
            ) {
                throw new Error(
                    "จำนวนเงินของ Payment ในฐานข้อมูลไม่ถูกต้อง"
                );
            }

            if (
                Math.abs(
                    slipAmount -
                    paymentAmount
                ) > 0.001
            ) {
                return res.status(400).json({
                    error:
                        `ยอดเงินไม่ตรง สลิป ${slipAmount.toFixed(2)} บาท แต่รายการ ${paymentAmount.toFixed(2)} บาท`
                });
            }

            /*
             * ทำรายการจริงใน PostgreSQL Transaction
             * และ lock Payment กันเติมซ้ำพร้อมกัน
             */

            const client =
                await pool.connect();

            try {

                await client.query(
                    "BEGIN"
                );

                const lockedPayment =
                    await client.query(
                        `
                        SELECT
                            id,
                            amount,
                            status,
                            qr_started_at,
                            expires_at,
                            clock_timestamp()
                                AS server_now

                        FROM payments

                        WHERE id = $1
                        AND user_id = $2

                        FOR UPDATE
                        `,
                        [
                            paymentId,
                            req.user.id
                        ]
                    );

                if (
                    !lockedPayment.rows.length
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(404).json({
                        error:
                            "ไม่พบรายการเติมเงิน"
                    });
                }

                const locked =
                    lockedPayment.rows[0];

                if (
                    locked.status !==
                    "PENDING"
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({
                        error:
                            "รายการนี้ถูกดำเนินการไปแล้ว"
                    });
                }

                if (
                    !locked.qr_started_at ||
                    !locked.expires_at
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(410).json({
                        error:
                            "รายการนี้ไม่มีเวลา QR กรุณาสร้างรายการใหม่"
                    });
                }

                const lockedStart =
                    new Date(
                        locked.qr_started_at
                    );

                const lockedExpire =
                    new Date(
                        locked.expires_at
                    );

                const lockedNow =
                    new Date(
                        locked.server_now
                    );

                /*
                 * เช็กเวลาจริงอีกรอบหลัง OCR
                 * ถ้า OCR ใช้เวลาจนเกิน 5 นาที
                 * จะไม่เติมยอด
                 */

                if (
                    lockedNow.getTime() >
                    lockedExpire.getTime()
                ) {
                    await client.query(
                        `
                        UPDATE payments

                        SET status = 'EXPIRED'

                        WHERE id = $1
                        AND user_id = $2
                        AND status = 'PENDING'
                        `,
                        [
                            paymentId,
                            req.user.id
                        ]
                    );

                    await client.query(
                        "COMMIT"
                    );

                    return res.status(410).json({
                        error:
                            "หมดเวลา 5 นาทีแล้ว กรุณาสร้าง QR ใหม่"
                    });
                }

                /*
                 * เช็กเวลาในสลิปอีกรอบด้วยเวลาที่ lock แล้ว
                 */

                const lockedStartMinute =
                    Math.floor(
                        lockedStart.getTime() /
                        60000
                    );

                const lockedExpireMinute =
                    Math.floor(
                        lockedExpire.getTime() /
                        60000
                    );

                const lockedNowMinute =
                    Math.floor(
                        lockedNow.getTime() /
                        60000
                    );

                if (
                    slipMinute <
                        lockedStartMinute ||
                    slipMinute >
                        lockedExpireMinute ||
                    slipMinute >
                        lockedNowMinute
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({
                        error:
                            "เวลาในสลิปไม่ตรงกับช่วงเวลา 5 นาทีของ QR"
                    });
                }

                /*
                 * เช็กยอดจาก row ที่ lock
                 */

                const lockedAmount =
                    Number(
                        locked.amount
                    );

                if (
                    !Number.isFinite(
                        lockedAmount
                    ) ||
                    Math.abs(
                        slipAmount -
                        lockedAmount
                    ) > 0.001
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({
                        error:
                            "จำนวนเงินในสลิปไม่ตรงกับรายการเติมเงิน"
                    });
                }

                /*
                 * สลิปเดิมห้ามใช้ซ้ำ
                 */

                const duplicate =
                    await client.query(
                        `
                        SELECT id
                        FROM payments
                        WHERE transaction_id = $1
                        LIMIT 1
                        `,
                        [
                            transactionId
                        ]
                    );

                if (
                    duplicate.rows.length
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({
                        error:
                            "สลิปนี้ถูกใช้ไปแล้ว"
                    });
                }

                const updatePayment =
                    await client.query(
                        `
                        UPDATE payments

                        SET
                            status = 'SUCCESS',
                            transaction_id = $1

                        WHERE id = $2
                        AND user_id = $3
                        AND status = 'PENDING'

                        RETURNING amount
                        `,
                        [
                            transactionId,
                            paymentId,
                            req.user.id
                        ]
                    );

                if (
                    !updatePayment.rows.length
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({
                        error:
                            "รายการนี้ถูกดำเนินการไปแล้ว"
                    });
                }

                const amount =
                    Number(
                        updatePayment
                            .rows[0]
                            .amount
                    );

                const userResult =
                    await client.query(
                        `
                        UPDATE users

                        SET balance =
                            balance + $1

                        WHERE id = $2

                        RETURNING balance
                        `,
                        [
                            amount,
                            req.user.id
                        ]
                    );

                if (
                    !userResult.rows.length
                ) {
                    throw new Error(
                        "ไม่พบผู้ใช้งาน"
                    );
                }

                await client.query(
                    "COMMIT"
                );

                return res.json({
                    success: true,

                    message:
                        "ตรวจสอบสลิปสำเร็จ เติมเงินเรียบร้อย",

                    amount,

                    balance:
                        Number(
                            userResult
                                .rows[0]
                                .balance
                        ),

                    transactionId,

                    payment: {
                        id:
                            paymentId,

                        qrStartedAt:
                            locked.qr_started_at,

                        expiresAt:
                            locked.expires_at
                    },

                    slip: {
                        sender:
                            slip.sender || "",

                        receiver:
                            slip.receiver || "",

                        date:
                            slip.date || "",

                        time:
                            slip.time || ""
                    }
                });

            } catch (error) {

                try {
                    await client.query(
                        "ROLLBACK"
                    );
                } catch {}

                throw error;

            } finally {

                client.release();
            }

        } catch (error) {

            console.error(
                "VERIFY ERROR:",
                error
            );

            /*
             * transaction_id UNIQUE
             * เป็นด่านสุดท้ายกันสลิปซ้ำ
             */

            if (
                error.code ===
                "23505"
            ) {
                return res.status(409).json({
                    error:
                        "สลิปนี้ถูกใช้ไปแล้ว"
                });
            }

            return res.status(500).json({
                error:
                    error.message ||
                    "ตรวจสอบสลิปไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   TRANSACTION HISTORY
========================= */

app.get(
    "/api/transactions",

    auth,

    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        amount,
                        transaction_id,
                        status,
                        created_at

                    FROM payments

                    WHERE user_id = $1

                    ORDER BY
                        created_at DESC

                    LIMIT 100
                    `,
                    [
                        req.user.id
                    ]
                );

            res.json({
                success: true,

                transactions:
                    result.rows.map(
                        item => ({
                            id:
                                item.id,

                            amount:
                                Number(
                                    item.amount
                                ),

                            transactionId:
                                item.transaction_id,

                            status:
                                item.status,

                            createdAt:
                                item.created_at
                        })
                    )
            });

        } catch (error) {
            console.error(
                "TRANSACTIONS ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "โหลดประวัติไม่สำเร็จ"
            });
        }
    }
);

/* =========================
   CLEAN EXPIRED SESSIONS
========================= */

async function cleanSessions() {
    try {
        await pool.query(
            `
            DELETE FROM sessions
            WHERE expires_at < NOW()
            `
        );

    } catch (error) {
        console.error(
            "SESSION CLEAN ERROR:",
            error
        );
    }
}

/* =========================
   ERROR HANDLER
========================= */

app.use(
    (error, req, res, next) => {
        console.error(
            "SERVER ERROR:",
            error
        );

        if (
            error.code ===
            "LIMIT_FILE_SIZE"
        ) {
            return res
                .status(400)
                .json({
                    error:
                        "ไฟล์สลิปต้องไม่เกิน 4MB"
                });
        }

        res.status(500).json({
            error:
                error.message ||
                "เกิดข้อผิดพลาด"
        });
    }
);

/* =========================
   START
========================= */

async function start() {
    try {
        await initDatabase();

        setInterval(
            cleanSessions,
            60 * 60 * 1000
        );

        app.listen(
            PORT,
            "0.0.0.0",

            () => {
                console.log(
                    `Server running on port ${PORT}`
                );
            }
        );

    } catch (error) {
        console.error(
            "START ERROR:",
            error
        );

        process.exit(1);
    }
}

start();

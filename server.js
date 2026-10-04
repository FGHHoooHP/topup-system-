require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;

const SESSION_DAYS = 30;

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

            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

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

function hashToken(token) {
    return crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
}

function createToken() {
    return crypto.randomBytes(48).toString("hex");
}

function getCookie(req, name) {
    const header = req.headers.cookie;

    if (!header) {
        return null;
    }

    const cookies = header
        .split(";")
        .map((item) => item.trim());

    const cookie = cookies.find(
        (item) =>
            item.startsWith(`${name}=`)
    );

    if (!cookie) {
        return null;
    }

    return decodeURIComponent(
        cookie.substring(name.length + 1)
    );
}

function setSessionCookie(res, token) {
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
            secure ? "Secure" : ""
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

async function auth(req, res, next) {
    try {
        const token =
            getCookie(
                req,
                "session"
            );

        if (!token) {
            return res.status(401).json({
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
                    sessions.id AS session_id,
                    sessions.expires_at,
                    users.id,
                    users.username,
                    users.balance

                FROM sessions

                INNER JOIN users
                    ON users.id =
                       sessions.user_id

                WHERE sessions.token_hash = $1
                AND sessions.expires_at > NOW()
                `,
                [tokenHash]
            );

        if (!result.rows.length) {
            clearSessionCookie(res);

            return res.status(401).json({
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

        res.status(500).json({
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
                return res.status(400).json({
                    error:
                        "Username ต้องมี 3-32 ตัว และใช้ A-Z, a-z, 0-9, _ เท่านั้น"
                });
            }

            if (password.length < 6) {
                return res.status(400).json({
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

            if (exists.rows.length) {
                return res.status(409).json({
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

                    VALUES ($1, $2)

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

            if (!result.rows.length) {
                return res.status(401).json({
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
                return res.status(401).json({
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
                    [hashToken(token)]
                );
            }

            clearSessionCookie(res);

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
                    [req.user.id]
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

            bank: "KBank",

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
            return res.status(503).json({
                error:
                    "ยังไม่ได้ตั้งค่า QR รับเงิน"
            });
        }

        res.json({
            success: true,

            bank: "KBank",

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
                return res.status(400).json({
                    error:
                        "จำนวนเงินไม่ถูกต้อง"
                });
            }

            if (
                amount > 1000000
            ) {
                return res.status(400).json({
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
                        status
                    )

                    VALUES (
                        $1,
                        $2,
                        'PENDING'
                    )

                    RETURNING
                        id,
                        amount,
                        status,
                        created_at
                    `,
                    [
                        req.user.id,
                        amount
                    ]
                );

            res.json({
                success: true,

                payment:
                    result.rows[0]
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

            /* FILE */

            if (!req.file) {
                return res.status(400).json({
                    error:
                        "กรุณาเลือกสลิป"
                });
            }

            /* PAYMENT */

            const paymentId =
                Number(
                    req.body.paymentId
                );

            if (!paymentId) {
                return res.status(400).json({
                    error:
                        "ไม่พบ Payment ID"
                });
            }

            /* GET PAYMENT */

            const paymentResult =
                await pool.query(
                    `
                    SELECT *
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

            /* STATUS */

            if (
                payment.status !==
                "PENDING"
            ) {
                return res.status(400).json({
                    error:
                        "รายการนี้ถูกตรวจสอบแล้ว"
                });
            }

            /* THUNDER KEY */

            if (
                !process.env
                    .THUNDER_API_KEY
            ) {
                return res.status(503).json({
                    error:
                        "ยังไม่ได้ตั้งค่า Thunder API Key"
                });
            }

            /* THUNDER URL */

            const thunderUrl =
                process.env
                    .THUNDER_API_URL ||
                "https://api.thunder.in.th/v2/verify/bank";

            console.log(
                "THUNDER URL:",
                thunderUrl
            );

            /* BASE64 */

            const base64 =
                req.file.buffer.toString(
                    "base64"
                );

            console.log(
                "SLIP MIME:",
                req.file.mimetype
            );

            console.log(
                "SLIP SIZE:",
                req.file.size
            );

            /* THUNDER */

            const thunderResponse =
                await fetch(
                    thunderUrl,
                    {
                        method:
                            "POST",

                        headers: {
                            Authorization:
                                `Bearer ${process.env.THUNDER_API_KEY}`,

                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                base64:

                                    base64,

                                matchAccount:
                                    true,

                                matchAmount:
                                    Number(
                                        payment.amount
                                    ),

                                checkDuplicate:
                                    true,

                                remark:
                                    `Payment #${payment.id}`
                            })
                    }
                );

            const thunderText =
                await thunderResponse.text();

            let thunderData;

            try {
                thunderData =
                    JSON.parse(
                        thunderText
                    );
            } catch {
                thunderData = {
                    raw:
                        thunderText
                };
            }

            console.log(
                "THUNDER STATUS:",
                thunderResponse.status
            );

            console.log(
                "THUNDER RESPONSE:",
                JSON.stringify(
                    thunderData
                )
            );

            /* THUNDER ERROR */

            if (
                !thunderResponse.ok
            ) {
                return res.status(400).json({
                    error:
                        thunderData
                            ?.error
                            ?.message ||
                        thunderData
                            ?.message ||
                        "Thunder ตรวจสอบสลิปไม่สำเร็จ"
                });
            }

            if (
                thunderData.success ===
                false
            ) {
                return res.status(400).json({
                    error:
                        thunderData
                            ?.error
                            ?.message ||
                        thunderData
                            ?.message ||
                        "สลิปไม่ผ่านการตรวจสอบ"
                });
            }

            const data =
                thunderData.data ||
                thunderData;

            /* DUPLICATE */

            if (
                data.isDuplicate ===
                true
            ) {
                return res.status(400).json({
                    error:
                        "สลิปนี้ถูกใช้ไปแล้ว"
                });
            }

            /* AMOUNT */

            if (
                data.isAmountMatched ===
                false
            ) {
                return res.status(400).json({
                    error:
                        "จำนวนเงินในสลิปไม่ตรงกับรายการ"
                });
            }

            /* ACCOUNT */

            if (
                data.matchedAccount ===
                false ||
                data.matchedAccount ==
                    null
            ) {
                return res.status(400).json({
                    error:
                        "บัญชีผู้รับไม่ตรงกับบัญชีที่ลงทะเบียนใน Thunder"
                });
            }

            /* TRANSACTION */

            const transactionId =
                data.rawSlip?.transRef ||
                data.transRef ||
                data.transactionId ||
                null;

            /* DUPLICATE TRANSACTION */

            if (transactionId) {

                const duplicate =
                    await pool.query(
                        `
                        SELECT id
                        FROM payments
                        WHERE transaction_id = $1
                        `,
                        [
                            transactionId
                        ]
                    );

                if (
                    duplicate.rows
                        .length
                ) {
                    return res.status(400).json({
                        error:
                            "Transaction นี้ถูกใช้แล้ว"
                    });
                }
            }

            /* DATABASE TRANSACTION */

            const client =
                await pool.connect();

            try {

                await client.query(
                    "BEGIN"
                );

                /* SUCCESS PAYMENT */

                const updatePayment =
                    await client.query(
                        `
                        UPDATE payments

                        SET
                            status = 'SUCCESS',
                            transaction_id = $1

                        WHERE id = $2

                        AND user_id = $3

                        AND status =
                            'PENDING'

                        RETURNING amount
                        `,
                        [
                            transactionId,
                            paymentId,
                            req.user.id
                        ]
                    );

                if (
                    !updatePayment
                        .rows.length
                ) {
                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({
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

                /* ADD USER BALANCE */

                await client.query(
                    `
                    UPDATE users

                    SET balance =
                        balance + $1

                    WHERE id = $2
                    `,
                    [
                        amount,
                        req.user.id
                    ]
                );

                await client.query(
                    "COMMIT"
                );

                console.log(
                    `User #${req.user.id} Payment #${paymentId} SUCCESS +${amount}`
                );

                return res.json({
                    success: true,

                    message:
                        "ตรวจสอบสลิปสำเร็จ เติมเงินเรียบร้อย",

                    amount,

                    transactionId
                });

            } catch (error) {

                await client.query(
                    "ROLLBACK"
                );

                throw error;

            } finally {

                client.release();
            }

        } catch (error) {

            console.error(
                "VERIFY ERROR:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "เกิดข้อผิดพลาดในการตรวจสอบสลิป"
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
                    [req.user.id]
                );

            res.json({
                success: true,

                transactions:
                    result.rows.map(
                        (item) => ({
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
            return res.status(400).json({
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

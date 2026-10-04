require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 4 * 1024 * 1024
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
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
   DATABASE
========================= */

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS wallet (
            id INTEGER PRIMARY KEY,
            balance NUMERIC(12,2) NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            amount NUMERIC(12,2) NOT NULL,
            transaction_id TEXT UNIQUE,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO wallet (id, balance)
        VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING;
    `);

    console.log("Database ready");
}

/* =========================
   BALANCE
========================= */

app.get("/api/balance", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT balance
            FROM wallet
            WHERE id = 1
        `);

        res.json({
            balance: Number(
                result.rows[0]?.balance || 0
            )
        });
    } catch (error) {
        console.error("BALANCE ERROR:", error);

        res.status(500).json({
            error: "โหลดยอดเงินไม่สำเร็จ"
        });
    }
});

/* =========================
   RECEIVER
========================= */

app.get("/api/receiver", (req, res) => {
    res.json({
        success: true,
        bank: "KBank",
        account:
            process.env.RECEIVER_ACCOUNT || "",
        name:
            process.env.RECEIVER_NAME || ""
    });
});

/* =========================
   QR
========================= */

app.get("/api/qr", (req, res) => {
    const qrUrl =
        process.env.RECEIVER_QR_URL;

    if (!qrUrl) {
        return res.status(503).json({
            error:
                "ยังไม่ได้ตั้งค่า QR รับเงิน"
        });
    }

    res.json({
        success: true,
        bank: "KBank",
        account:
            process.env.RECEIVER_ACCOUNT || "",
        name:
            process.env.RECEIVER_NAME || "",
        qr: qrUrl
    });
});

/* =========================
   CREATE TOPUP
========================= */

app.post("/api/topup", async (req, res) => {
    try {
        const amount =
            Number(req.body.amount);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return res.status(400).json({
                error:
                    "จำนวนเงินไม่ถูกต้อง"
            });
        }

        if (amount > 1000000) {
            return res.status(400).json({
                error:
                    "จำนวนเงินเกินกำหนด"
            });
        }

        const result =
            await pool.query(
                `
                INSERT INTO payments (
                    amount,
                    status
                )
                VALUES ($1, 'PENDING')
                RETURNING
                    id,
                    amount,
                    status,
                    created_at
                `,
                [amount]
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
                "สร้างรายการไม่สำเร็จ"
        });
    }
});

/* =========================
   VERIFY SLIP
   THUNDER V2 BASE64
========================= */

app.post(
    "/api/verify-slip",
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
                Number(req.body.paymentId);

            if (!paymentId) {
                return res.status(400).json({
                    error:
                        "ไม่พบ Payment ID"
                });
            }

            /* ตรวจสอบ Payment */

            const paymentResult =
                await pool.query(
                    `
                    SELECT *
                    FROM payments
                    WHERE id = $1
                    `,
                    [paymentId]
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
                return res.status(400).json({
                    error:
                        "รายการนี้ถูกตรวจสอบแล้ว"
                });
            }

            /* ตรวจ API KEY */

            if (
                !process.env.THUNDER_API_KEY
            ) {
                return res.status(503).json({
                    error:
                        "ยังไม่ได้ตั้งค่า Thunder API Key"
                });
            }

            /* Thunder URL */

            const thunderUrl =
                process.env.THUNDER_API_URL ||
                "https://api.thunder.in.th/v2/verify/bank";

            console.log(
                "THUNDER URL:",
                thunderUrl
            );

            /* แปลงรูปเป็น Base64 */

            const base64 =
                req.file.buffer.toString(
                    "base64"
                );

            const imageData =
                `data:${req.file.mimetype};base64,${base64}`;

            /* ส่งไป Thunder */

            const thunderResponse =
                await fetch(
                    thunderUrl,
                    {
                        method: "POST",

                        headers: {
                            Authorization:
                                `Bearer ${process.env.THUNDER_API_KEY}`,

                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            base64:
                                imageData,

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

            /* Thunder Error */

            if (
                !thunderResponse.ok ||
                thunderData.success === false
            ) {
                return res.status(400).json({
                    error:
                        thunderData?.error?.message ||
                        thunderData?.message ||
                        "Thunder ตรวจสอบสลิปไม่สำเร็จ"
                });
            }

            const data =
                thunderData.data ||
                thunderData;

            /* สลิปซ้ำ */

            if (
                data.isDuplicate === true
            ) {
                return res.status(400).json({
                    error:
                        "สลิปนี้ถูกใช้ไปแล้ว"
                });
            }

            /* จำนวนเงิน */

            if (
                data.isAmountMatched ===
                false
            ) {
                return res.status(400).json({
                    error:
                        "จำนวนเงินในสลิปไม่ตรงกับรายการ"
                });
            }

            /* บัญชีผู้รับ */

            if (
                !data.matchedAccount
            ) {
                return res.status(400).json({
                    error:
                        "บัญชีผู้รับไม่ตรงกับบัญชีที่ลงทะเบียนใน Thunder"
                });
            }

            /* Transaction ID */

            const transactionId =
                data.rawSlip?.transRef ||
                data.transRef ||
                data.transactionId ||
                null;

            /* ป้องกัน Transaction ซ้ำ */

            if (transactionId) {

                const duplicateResult =
                    await pool.query(
                        `
                        SELECT id
                        FROM payments
                        WHERE transaction_id = $1
                        `,
                        [transactionId]
                    );

                if (
                    duplicateResult.rows.length
                ) {
                    return res.status(400).json({
                        error:
                            "Transaction นี้ถูกใช้แล้ว"
                    });
                }
            }

            /* =========================
               UPDATE DATABASE
            ========================= */

            const client =
                await pool.connect();

            try {

                await client.query(
                    "BEGIN"
                );

                /* เปลี่ยน Payment เป็น SUCCESS */

                const updatePayment =
                    await client.query(
                        `
                        UPDATE payments

                        SET
                            status = 'SUCCESS',
                            transaction_id = $1

                        WHERE id = $2
                        AND status = 'PENDING'

                        RETURNING amount
                        `,
                        [
                            transactionId,
                            payment.id
                        ]
                    );

                if (
                    !updatePayment.rows.length
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(400).json({
                        error:
                            "รายการนี้ถูกดำเนินการไปแล้ว"
                    });
                }

                /* จำนวนเงิน */

                const amount =
                    Number(
                        updatePayment
                            .rows[0]
                            .amount
                    );

                /* เพิ่ม Balance */

                await client.query(
                    `
                    UPDATE wallet

                    SET balance =
                        balance + $1

                    WHERE id = 1
                    `,
                    [amount]
                );

                await client.query(
                    "COMMIT"
                );

                console.log(
                    `Payment #${payment.id} SUCCESS +${amount}`
                );

                return res.json({
                    success: true,

                    message:
                        "ตรวจสอบสลิปสำเร็จ เติมเงินเรียบร้อย",

                    amount:
                        amount,

                    transactionId:
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
                    "เกิดข้อผิดพลาดในการตรวจสอบสลิป"
            });
        }
    }
);

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
   START SERVER
========================= */

async function start() {

    try {

        await initDatabase();

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

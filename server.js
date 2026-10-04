require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { Pool } = require("pg");
const generatePayload = require("promptpay-qr");

const app = express();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;


/* =========================
   เปิดหน้าเว็บ
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
   ยอดเงิน
========================= */

app.get("/api/balance", async (req, res) => {

    try {

        const result = await pool.query(
            "SELECT balance FROM wallet WHERE id = 1"
        );

        res.json({
            balance: Number(
                result.rows[0].balance
            )
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "โหลดยอดเงินไม่สำเร็จ"
        });

    }

});


/* =========================
   สร้าง PromptPay QR จริง
========================= */

app.get("/api/qr", (req, res) => {

    try {

        const amount =
            Number(req.query.amount);

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(400).json({
                error: "จำนวนเงินไม่ถูกต้อง"
            });

        }


        const promptpay =
            process.env.RECEIVER_PROMPTPAY;


        if (!promptpay) {

            return res.status(500).json({
                error:
                    "ยังไม่ได้ตั้งค่า RECEIVER_PROMPTPAY"
            });

        }


        /*
         * สร้าง PromptPay Payload
         */

        const payload =
            generatePayload(
                promptpay,
                {
                    amount: amount
                }
            );


        res.json({

            success: true,

            receiverName:
                process.env.RECEIVER_NAME || "",

            promptpay:
                promptpay,

            amount:
                amount,

            payload:
                payload

        });

    } catch (error) {

        console.error(
            "QR ERROR:",
            error
        );

        res.status(500).json({
            error:
                "สร้าง QR ไม่สำเร็จ"
        });

    }

});


/* =========================
   สร้างรายการเติมเงิน
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


        const result =
            await pool.query(
                `
                INSERT INTO payments (amount)
                VALUES ($1)
                RETURNING id, amount, status
                `,
                [amount]
            );


        res.json({

            success: true,

            payment:
                result.rows[0]

        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                "สร้างรายการไม่สำเร็จ"
        });

    }

});


/* =========================
   ตรวจสลิป
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


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM payments
                    WHERE id = $1
                    `,
                    [paymentId]
                );


            if (!result.rows.length) {

                return res.status(404).json({
                    error:
                        "ไม่พบรายการเติมเงิน"
                });

            }


            const payment =
                result.rows[0];


            if (
                payment.status !==
                "PENDING"
            ) {

                return res.status(400).json({
                    error:
                        "รายการนี้ถูกตรวจสอบแล้ว"
                });

            }


            /* =========================
               Thunder Solution
            ========================= */

            if (
                !process.env.THUNDER_API_URL ||
                !process.env.THUNDER_API_KEY
            ) {

                return res.status(503).json({
                    error:
                        "ยังไม่ได้เชื่อม Thunder Solution"
                });

            }


            /*
             * ตรงนี้จะเชื่อม API จริง
             *
             * ยังไม่ใส่ API ปลอม
             * เพราะต้องใช้รูปแบบ API
             * จาก Thunder Solution จริง
             */


            const verification = {

                success: false,

                transactionId: null

            };


            if (!verification.success) {

                return res.status(400).json({
                    error:
                        "สลิปไม่ผ่านการตรวจสอบ"
                });

            }


            /* =========================
               Database Transaction
            ========================= */

            const client =
                await pool.connect();


            try {

                await client.query(
                    "BEGIN"
                );


                /*
                 * กัน Transaction ซ้ำ
                 */

                const duplicate =
                    await client.query(
                        `
                        SELECT id
                        FROM payments
                        WHERE transaction_id = $1
                        FOR UPDATE
                        `,
                        [
                            verification.transactionId
                        ]
                    );
app.get("/api/qr", (req, res) => {
    try {
        const amount = Number(req.query.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                error: "จำนวนเงินไม่ถูกต้อง"
            });
        }

        const receiverName = process.env.RECEIVER_NAME;
        const promptpay = process.env.RECEIVER_PROMPTPAY;

        console.log("RECEIVER_NAME =", receiverName);
        console.log("RECEIVER_PROMPTPAY =", promptpay);

        if (!receiverName) {
            return res.status(500).json({
                error: "ไม่พบ RECEIVER_NAME ใน Railway Variables"
            });
        }

        if (!promptpay) {
            return res.status(500).json({
                error: "ไม่พบ RECEIVER_PROMPTPAY ใน Railway Variables"
            });
        }

        const payload = generatePayload(promptpay, {
            amount: amount
        });

        res.json({
            success: true,
            receiverName: receiverName,
            promptpay: promptpay,
            amount: amount,
            payload: payload
        });

    } catch (error) {
        console.error("QR ERROR:", error);

        res.status(500).json({
            error: "สร้าง QR ไม่สำเร็จ"
        });
    }
});

                if (
                    duplicate.rows.length
                ) {

                    await client.query(
                        "ROLLBACK"
                    );

                    return res.status(409).json({
                        error:
                            "สลิปนี้ถูกใช้แล้ว"
                    });

                }


                /*
                 * เปลี่ยนสถานะ
                 */

                await client.query(
                    `
                    UPDATE payments
                    SET
                        transaction_id = $1,
                        status = 'SUCCESS'
                    WHERE id = $2
                    `,
                    [
                        verification.transactionId,
                        paymentId
                    ]
                );


                /*
                 * เพิ่มยอดเงิน
                 */

                await client.query(
                    `
                    UPDATE wallet
                    SET balance =
                        balance + $1
                    WHERE id = 1
                    `,
                    [
                        payment.amount
                    ]
                );


                await client.query(
                    "COMMIT"
                );


                res.json({

                    success: true,

                    amount:
                        Number(
                            payment.amount
                        )

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
                    "เกิดข้อผิดพลาด"
            });

        }

    }
);


/* =========================
   Health Check
========================= */

app.get("/api/health", (req, res) => {

    res.json({
        status: "online"
    });

});


/* =========================
   Start Server
========================= */

async function start() {

    try {

        await initDatabase();


        app.listen(
            PORT,
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

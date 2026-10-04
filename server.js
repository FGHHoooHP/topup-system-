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

/* =========================
   หน้าเว็บ
========================= */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
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
            balance: Number(result.rows[0].balance)
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "โหลดยอดเงินไม่สำเร็จ"
        });
    }
});

/* =========================
   ข้อมูลบัญชีรับเงิน
========================= */

app.get("/api/receiver", (req, res) => {

    res.json({
        success: true,
        bank: "KBank",
        account: process.env.RECEIVER_ACCOUNT || "2202587596",
        name: process.env.RECEIVER_NAME || ""
    });

});

/* =========================
   QR รับเงิน
========================= */

app.get("/api/qr", (req, res) => {

    const qrUrl = process.env.RECEIVER_QR_URL;

    if (!qrUrl) {

        return res.status(503).json({
            error: "ยังไม่ได้ตั้งค่า QR รับเงินจาก KBank"
        });

    }

    res.json({
        success: true,
        bank: "KBank",
        account: process.env.RECEIVER_ACCOUNT || "2202587596",
        name: process.env.RECEIVER_NAME || "",
        qr: qrUrl
    });

});

/* =========================
   สร้างรายการเติมเงิน
========================= */

app.post("/api/topup", async (req, res) => {

    try {

        const amount = Number(req.body.amount);

        if (!Number.isFinite(amount) || amount <= 0) {

            return res.status(400).json({
                error: "จำนวนเงินไม่ถูกต้อง"
            });

        }

        const result = await pool.query(
            `
            INSERT INTO payments (amount)
            VALUES ($1)
            RETURNING id, amount, status
            `,
            [amount]
        );

        res.json({
            success: true,
            payment: result.rows[0]
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "สร้างรายการไม่สำเร็จ"
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
                    error: "กรุณาเลือกสลิป"
                });

            }

            const paymentId =
                Number(req.body.paymentId);

            if (!paymentId) {

                return res.status(400).json({
                    error: "ไม่พบ Payment ID"
                });

            }

            const result = await pool.query(
                `
                SELECT *
                FROM payments
                WHERE id = $1
                `,
                [paymentId]
            );

            if (!result.rows.length) {

                return res.status(404).json({
                    error: "ไม่พบรายการเติมเงิน"
                });

            }

            const payment = result.rows[0];

            if (payment.status !== "PENDING") {

                return res.status(400).json({
                    error: "รายการนี้ถูกตรวจสอบแล้ว"
                });

            }

            /*
             * Thunder Solution
             *
             * ตอนนี้ยังไม่ได้ใส่ API จริง
             * เพราะต้องใช้ URL และรูปแบบ Request
             * จาก API ของ Thunder Solution จริง
             */

            if (
                !process.env.THUNDER_API_URL ||
                !process.env.THUNDER_API_KEY
            ) {

                return res.status(503).json({
                    error: "ยังไม่ได้เชื่อม Thunder Solution"
                });

            }

            return res.status(501).json({
                error: "Thunder API ยังไม่ได้ติดตั้งในระบบ"
            });

        } catch (error) {

            console.error(
                "VERIFY ERROR:",
                error
            );

            res.status(500).json({
                error: "เกิดข้อผิดพลาด"
            });
        }

    }
);

/* =========================
   Health
========================= */

app.get("/api/health", (req, res) => {

    res.json({
        status: "online"
    });

});

/* =========================
   Start
========================= */

async function start() {

    try {

        await initDatabase();

        app.listen(PORT, () => {

            console.log(
                `Server running on port ${PORT}`
            );

        });

    } catch (error) {

        console.error(
            "START ERROR:",
            error
        );

        process.exit(1);
    }

}

start();

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

            if (req.file.size > 4 * 1024 * 1024) {
                return res.status(400).json({
                    error: "ไฟล์สลิปต้องไม่เกิน 4MB"
                });
            }

            const paymentId = Number(req.body.paymentId);

            if (!paymentId) {
                return res.status(400).json({
                    error: "ไม่พบ Payment ID"
                });
            }

            const paymentResult = await pool.query(
                `
                SELECT *
                FROM payments
                WHERE id = $1
                `,
                [paymentId]
            );

            if (!paymentResult.rows.length) {
                return res.status(404).json({
                    error: "ไม่พบรายการเติมเงิน"
                });
            }

            const payment = paymentResult.rows[0];

            if (payment.status !== "PENDING") {
                return res.status(400).json({
                    error: "รายการนี้ถูกตรวจสอบแล้ว"
                });
            }

            if (!process.env.THUNDER_API_KEY) {
                return res.status(503).json({
                    error: "ยังไม่ได้ตั้งค่า Thunder API Key"
                });
            }

            const formData = new FormData();

            const blob = new Blob(
                [req.file.buffer],
                {
                    type: req.file.mimetype
                }
            );

            formData.append(
                "image",
                blob,
                req.file.originalname
            );

            formData.append(
                "matchAccount",
                "true"
            );

            formData.append(
                "matchAmount",
                String(Number(payment.amount))
            );

            formData.append(
                "checkDuplicate",
                "true"
            );

            formData.append(
                "remark",
                `Payment #${payment.id}`
            );

            const thunderResponse = await fetch(
                process.env.THUNDER_API_URL ||
                "https://api.thunder.in.th/v2/verify/bank",
                {
                    method: "POST",
                    headers: {
                        "Authorization":
                            `Bearer ${process.env.THUNDER_API_KEY}`
                    },
                    body: formData
                }
            );

            const thunderData =
                await thunderResponse.json();

            console.log(
                "THUNDER:",
                JSON.stringify(thunderData)
            );

            if (!thunderResponse.ok) {
                return res.status(400).json({
                    error:
                        thunderData?.error?.message ||
                        "Thunder ตรวจสอบสลิปไม่สำเร็จ"
                });
            }

            if (!thunderData.success) {
                return res.status(400).json({
                    error:
                        thunderData?.error?.message ||
                        "สลิปไม่ผ่านการตรวจสอบ"
                });
            }

            const data = thunderData.data;

            if (data.isDuplicate) {
                return res.status(400).json({
                    error: "สลิปนี้ถูกใช้ไปแล้ว"
                });
            }

            if (data.isAmountMatched === false) {
                return res.status(400).json({
                    error: "จำนวนเงินในสลิปไม่ตรงกับรายการ"
                });
            }

            if (!data.matchedAccount) {
                return res.status(400).json({
                    error: "บัญชีผู้รับไม่ตรงกับบัญชีที่ลงทะเบียน"
                });
            }

            const transactionId =
                data.rawSlip?.transactionId ||
                data.rawSlip?.transaction?.id ||
                null;

            const client = await pool.connect();

            try {
                await client.query("BEGIN");

                const updateResult = await client.query(
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

                if (!updateResult.rows.length) {
                    await client.query("ROLLBACK");

                    return res.status(400).json({
                        error: "รายการนี้ถูกดำเนินการไปแล้ว"
                    });
                }

                await client.query(
                    `
                    UPDATE wallet
                    SET balance = balance + $1
                    WHERE id = 1
                    `,
                    [
                        updateResult.rows[0].amount
                    ]
                );

                await client.query("COMMIT");

                res.json({
                    success: true,
                    message: "ตรวจสอบสลิปสำเร็จ เติมเงินเรียบร้อย",
                    amount:
                        Number(updateResult.rows[0].amount),
                    transactionId
                });

            } catch (error) {

                await client.query("ROLLBACK");
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
                error: "เกิดข้อผิดพลาดในการตรวจสอบสลิป"
            });
        }
    }
);

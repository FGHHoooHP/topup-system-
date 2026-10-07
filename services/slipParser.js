const { createWorker } = require("tesseract.js");

function cleanLine(text) {
    return String(text || "")
        .replace(/\r/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function findAmount(text) {
    const matches = [
        ...text.matchAll(/([\d,]+\.\d{2})\s*บาท/gi)
    ];

    if (!matches.length) {
        return "";
    }

    // จำนวนแรกคือยอดโอน
    // จำนวนถัดไปมักเป็นค่าธรรมเนียม
    return matches[0][1].replace(/,/g, "");
}

function findTransactionId(text) {
    const lines = text
        .split("\n")
        .map(cleanLine)
        .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
        if (
            /เลขที่รายการ|เลขรายการ|transaction|reference/i.test(lines[i])
        ) {
            let match = lines[i].match(/[A-Z0-9]{15,30}/i);

            if (match) {
                return match[0];
            }

            for (
                let x = i + 1;
                x < Math.min(i + 4, lines.length);
                x++
            ) {
                match = lines[x].match(/[A-Z0-9]{15,30}/i);

                if (match) {
                    return match[0];
                }
            }
        }
    }

    return "";
}

function findDateTime(text) {
    const match = text.match(
        /(\d{1,2}\s+[ก-๙A-Za-z.]+\s+\d{2,4})\s+(\d{1,2}:\d{2})/
    );

    if (!match) {
        return {
            date: "",
            time: ""
        };
    }

    return {
        date: cleanLine(match[1]),
        time: match[2]
    };
}

function findPeople(text) {
    const lines = text
        .split("\n")
        .map(cleanLine)
        .filter(Boolean);

    const names = [];

    const namePattern =
        /^(นาย|นางสาว|นาง|ด\.ช\.|ด\.ญ\.)\s*.+/;

    for (const line of lines) {
        if (namePattern.test(line)) {
            if (!names.includes(line)) {
                names.push(line);
            }
        }
    }

    return {
        sender: names[0] || "",
        receiver: names[1] || ""
    };
}

async function parseSlip(imageInput) {
    console.log("");
    console.log("========== OCR START ==========");

    const worker = await createWorker(
        ["tha", "eng"],
        1,
        {
            logger: (m) => {
                if (m.progress) {
                    console.log(
                        `${m.status}: ${Math.round(m.progress * 100)}%`
                    );
                }
            }
        }
    );

    try {
        const result = await worker.recognize(imageInput);

        const raw_text =
            result?.data?.text || "";

        console.log("");
        console.log("========== RAW TEXT ==========");
        console.log(raw_text);
        console.log("==============================");

        const people =
            findPeople(raw_text);

        const dateTime =
            findDateTime(raw_text);

        const amount =
            findAmount(raw_text);

        const transaction_id =
            findTransactionId(raw_text);

        const parsed = {
            sender: people.sender,
            receiver: people.receiver,
            amount,
            transaction_id,
            date: dateTime.date,
            time: dateTime.time,
            raw_text
        };

        console.log("");
        console.log("========== PARSED ==========");
        console.log(parsed);
        console.log("============================");

        return parsed;

    } finally {
        await worker.terminate();
    }
}

module.exports = {
    parseSlip
};

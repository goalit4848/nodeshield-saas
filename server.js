const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const activeBatches = new Map();

async function checkSpamWithGroq(messagesText) {
    if (!GROQ_API_KEY) return 'PASS';
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: 'Reply "BLOCK" if spam/malicious, else "PASS".' }, { role: 'user', content: messagesText }],
                temperature: 0, max_tokens: 10
            })
        });
        const data = await response.json();
        return data?.choices?.[0]?.message?.content?.trim().toUpperCase() || 'PASS';
    } catch (e) { return 'PASS'; }
}

app.post('/api/shield/:shield_id', async (req, res) => {
    const { shield_id } = req.params;
    const payload = req.body;

    // 1. Instant 200 OK
    res.status(200).send("Buffered");

    // 2. Initialize batch IMMEDIATELY
    if (!activeBatches.has(shield_id)) {
        activeBatches.set(shield_id, {
            messages: [],
            timerId: null,
            destination_url: null,
            delay_timer: 15000 // Hardcoded 15s backup
        });

        // Async check Supabase in the background without blocking the timer
        supabase.from('users').select('destination_url, delay_timer').eq('shield_id', shield_id).single()
            .then(({ data }) => {
                if (data) {
                    const b = activeBatches.get(shield_id);
                    if (b) {
                        b.destination_url = data.destination_url;
                        if (data.delay_timer) b.delay_timer = data.delay_timer;
                    }
                }
            });
    }

    const batch = activeBatches.get(shield_id);
    batch.messages.push(payload);

    // 3. Reset and Start Timer
    clearTimeout(batch.timerId);
    batch.timerId = setTimeout(async () => {
        const finalMessages = [...batch.messages];
        const currentBatch = activeBatches.get(shield_id);
        const destUrl = currentBatch?.destination_url;
        activeBatches.delete(shield_id);

        if (!destUrl) {
            console.log("Error: No destination URL found in Supabase for " + shield_id);
            return;
        }

        const justTheText = finalMessages.map(item => item.sender?.message || '').join(' | ');
        const aiDecision = await checkSpamWithGroq(justTheText);

        if (aiDecision.includes('BLOCK')) return;

        try {
            const response = await fetch(destUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shield_id, messages: finalMessages, text: justTheText })
            });
            console.log(`[SENT] Delivered to Make. Status: ${response.status}`);
        } catch (err) { console.error('Forwarding failed', err); }

    }, batch.delay_timer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine active on ${PORT}`));

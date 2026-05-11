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

    console.log(`\n[1] Message arrived from Unipile for: ${shield_id}`);
    res.status(200).send("Buffered");

    if (!activeBatches.has(shield_id)) {
        activeBatches.set(shield_id, {
            messages: [],
            timerId: null,
            destination_url: null,
            delay_timer: 15000 
        });

        // Background check to Supabase
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

    clearTimeout(batch.timerId);
    console.log(`[2] Timer restarted. Waiting...`);

    batch.timerId = setTimeout(async () => {
        console.log(`[3] Timer finished. Bundled ${batch.messages.length} messages.`);
        const finalMessages = [...batch.messages];
        const currentBatch = activeBatches.get(shield_id);
        activeBatches.delete(shield_id);

        // BULLETPROOF FIX 1: The URL Fallback
        const safeUrl = currentBatch?.destination_url || "https://hook.eu1.make.com/vl53oljhoahccjhsmgvqw1wm7os98nm2";

        // BULLETPROOF FIX 2: Prevent null crashes from images/empty texts
        const extractedChatId = finalMessages[0]?.account_info?.chat_id || "unknown_chat";
        const rawText = finalMessages.map(item => item.sender?.message || "media_or_empty").join(' | ');
        
        console.log(`[4] Extracted Text: "${rawText}"`);

        const aiDecision = await checkSpamWithGroq(rawText);
        if (aiDecision.includes('BLOCK')) {
            console.log(`[SHIELD] Spam blocked by AI.`);
            return;
        }

        console.log(`[5] Sending to Make.com at ${safeUrl}...`);
        
        try {
            const response = await fetch(safeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // BULLETPROOF FIX 3: Strict Strings
                body: JSON.stringify({ 
                    shield_id: String(shield_id),
                    chat_id: String(extractedChatId),
                    text_for_ai: String(rawText),
                    total_messages_bundled: finalMessages.length
                })
            });
            console.log(`[6] SUCCESS! Make.com caught it (Status: ${response.status})`);
        } catch (err) { 
            console.error('[ERROR] Forwarding failed', err); 
        }

    }, batch.delay_timer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine active on ${PORT}`));

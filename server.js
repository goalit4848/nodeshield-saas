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

    res.status(200).send("Buffered");

    if (!activeBatches.has(shield_id)) {
        activeBatches.set(shield_id, {
            messages: [],
            timerId: null,
            destination_url: null,
            delay_timer: 15000 
        });

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
    batch.timerId = setTimeout(async () => {
        const finalMessages = [...batch.messages];
        const currentBatch = activeBatches.get(shield_id);
        const destUrl = currentBatch?.destination_url;
        activeBatches.delete(shield_id);

        if (!destUrl) return;

        const justTheText = finalMessages.map(item => item.sender?.message || '').join(' | ');
        const aiDecision = await checkSpamWithGroq(justTheText);

        if (aiDecision.includes('BLOCK')) {
            console.log(`[SHIELD] Blocked spam from ${shield_id}`);
            return;
        }

        // --- THE MASTER FIX ---
        // Strip out Unipile garbage. Find the chat_id from the first message.
        const extractedChatId = finalMessages[0]?.account_info?.chat_id || '';

        try {
            const response = await fetch(destUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    shield_id: shield_id,
                    chat_id: extractedChatId,
                    text_for_ai: justTheText,
                    total_messages_bundled: finalMessages.length
                })
            });
            console.log(`[SENT] Delivered to Make. Status: ${response.status}`);
        } catch (err) { console.error('Forwarding failed', err); }

    }, batch.delay_timer);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine active on ${PORT}`));

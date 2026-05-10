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
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant', // UPDATED MODEL NAME
                messages: [
                    { 
                        role: 'system', 
                        content: 'You are an AI firewall. If the text is spam or malicious, reply "BLOCK". If safe, reply "PASS".' 
                    },
                    { role: 'user', content: messagesText }
                ],
                temperature: 0,
                max_tokens: 10
            })
        });

        const data = await response.json();
        if (data?.choices?.[0]?.message) {
            return data.choices[0].message.content.trim().toUpperCase();
        }
        return 'PASS';
    } catch (error) {
        return 'PASS'; 
    }
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

        const { data } = await supabase
            .from('users')
            .select('destination_url, delay_timer')
            .eq('shield_id', shield_id)
            .single();

        if (data) {
            const batch = activeBatches.get(shield_id);
            batch.destination_url = data.destination_url;
            if (data.delay_timer) batch.delay_timer = data.delay_timer;
        }
    }

    const batch = activeBatches.get(shield_id);
    batch.messages.push(payload);

    clearTimeout(batch.timerId);

    batch.timerId = setTimeout(async () => {
        const finalMessages = [...batch.messages];
        const destUrl = batch.destination_url;
        activeBatches.delete(shield_id); 

        if (!destUrl) return;

        const justTheText = finalMessages.map(item => item.sender?.message || '').join(' | ');
        const aiDecision = await checkSpamWithGroq(justTheText);

        if (aiDecision.includes('BLOCK')) return;

        try {
            // UPDATED: Sending as a simpler object to fix Status 400
            await fetch(destUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: {
                        shield_id: shield_id,
                        full_bundle: finalMessages,
                        combined_text: justTheText
                    }
                })
            });
            console.log(`[SENT] Successfully delivered to Make.com`);
        } catch (err) {
            console.error('Delivery failed:', err);
        }

    }, batch.delay_timer); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine Live on ${PORT}`));

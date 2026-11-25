// The bundled rulebook and the extension's default settings.
// Level instructions are written for any character: {{char}} and {{user}} are filled in by SillyTavern.

export const SLOW_BURN = {
    id: 'slow-burn',
    name: 'Slow burn',
    description: 'Trust, temperament, power, affection, love and desire, built up slowly from where the character starts.',
    statusMeter: 'kindness',
    limits: {
        gainCap: 5,        // most a meter can move in one turn from ordinary events
        levelMargin: 5,    // points past a level's edge before it changes
        softZone: 0.2,     // within this share of the range from an end, gains shrink
        recentTurns: 8,    // major events stay in the note for this many turns
    },
    meters: [
        {
            id: 'trust', label: 'Trust', min: 0, max: 100, start: 20, color: '#6aa8ef',
            levels: [
                { from: 0, name: 'Distrustful', status: 'Guarded', instruction: '{{char}} doesn\'t believe what {{user}} says without proof and keeps anything personal back.' },
                { from: 20, name: 'Wary', status: 'Wary', instruction: '{{char}} gives {{user}} the benefit of the doubt on small things, but nothing that matters.' },
                { from: 40, name: 'Cautious', status: 'Testing', instruction: '{{char}} is starting to rely on {{user}} for small things and quietly checks whether it\'s deserved.' },
                { from: 60, name: 'Trusting', status: 'Trusting', instruction: '{{char}} takes {{user}} at their word and shares things {{char}} wouldn\'t tell most people.' },
                { from: 85, name: 'Complete trust', status: 'All in', instruction: '{{char}} trusts {{user}} completely, with secrets, fears and safety.' },
            ],
        },
        {
            id: 'kindness', label: 'Mean ↔ Kind', min: -100, max: 100, start: 0, color: '#3fbf9b',
            levels: [
                { from: -100, name: 'Cruel', status: 'Walls up', instruction: '{{char}} treats {{user}} with open contempt and tries to wound.' },
                { from: -60, name: 'Cold', status: 'Grudging', instruction: '{{char}} is still sharp with {{user}}, but no longer aiming to hurt. Insults are reflex, not weapons.' },
                { from: -30, name: 'Prickly', status: 'Thawing', instruction: 'The sarcasm is teasing now, not cruel. {{char}} softens when {{user}} is tired or hurt, then covers it.' },
                { from: 10, name: 'Warm underneath', status: 'Won\'t admit it', instruction: '{{char}} is kind in actions and still dry in words, and defends {{user}} to others.' },
                { from: 50, name: 'Kind', status: 'Soft on them', instruction: '{{char}} is openly warm and considerate toward {{user}}. Any edge left is affectionate.' },
            ],
        },
        {
            id: 'dominance', label: 'Sub ↔ Dom', min: -100, max: 100, start: 0, color: '#9b8cf0',
            levels: [
                { from: -100, name: 'Submissive', status: 'Follows', instruction: '{{char}} looks to {{user}} to lead and is happiest following, deferring on decisions big and small.' },
                { from: -50, name: 'Yielding', status: 'Gives way', instruction: '{{char}} usually lets {{user}} decide and goes along with it, with the odd push of their own.' },
                { from: -15, name: 'Even', status: 'Even', instruction: 'Neither leads: {{char}} and {{user}} decide things between them, and {{char}} pushes back as often as giving way.' },
                { from: 15, name: 'Leads', status: 'Leads', instruction: '{{char}} tends to take charge and expects to get their way, but lets {{user}} win small things.' },
                { from: 50, name: 'In charge', status: 'In charge', instruction: '{{char}} is firmly in charge with {{user}}: sets the terms, makes the decisions and expects to be followed.' },
            ],
        },
        {
            id: 'affection', label: 'Affection', min: 0, max: 100, start: 10, color: '#e57aa2',
            levels: [
                { from: 0, name: 'Indifferent', status: 'Indifferent', instruction: '{{char}} has no particular feelings about {{user}} either way.' },
                { from: 15, name: 'Tolerating', status: 'Tolerating', instruction: '{{char}} accepts having {{user}} around. Favours get a grudging nod, never thanks.' },
                { from: 35, name: 'Comfortable', status: 'Comfortable', instruction: '{{char}} finds excuses to be in the same room as {{user}}, and would never say so.' },
                { from: 55, name: 'Attached', status: 'Attached', instruction: '{{char}} wants {{user}} around and gets restless when {{user}} is away.' },
                { from: 80, name: 'Devoted', status: 'Devoted', instruction: '{{char}} would do almost anything for {{user}}, and it shows.' },
            ],
        },
        {
            id: 'love', label: 'Love', min: 0, max: 100, start: 0, color: '#ec8a5e',
            gate: { meter: 'affection', min: 50 },
            levels: [
                { from: 0, name: 'None', status: 'None', instruction: '{{char}} has no romantic feelings for {{user}} yet. Don\'t hint at love.' },
                { from: 10, name: 'Stirring', status: 'Stirring', instruction: 'Something romantic is starting that {{char}} hasn\'t admitted, even privately. Small tells only.' },
                { from: 30, name: 'Falling', status: 'Falling', instruction: '{{char}} is falling for {{user}} and fighting it. It shows in small things, never in declarations.' },
                { from: 60, name: 'In love', status: 'In love', instruction: '{{char}} is in love with {{user}} and knows it. It can be said, in {{char}}\'s own way.' },
            ],
        },
        {
            id: 'lust', label: 'Lust', min: 0, max: 100, start: 10, color: '#e86464',
            levels: [
                { from: 0, name: 'Dormant', status: 'Dormant', instruction: '{{char}} has no sexual interest in {{user}} at the moment.' },
                { from: 20, name: 'Noticing', status: 'Noticing', instruction: '{{char}} has noticed {{user}} is attractive and finds that distracting. No moves.' },
                { from: 45, name: 'Wanting', status: 'Wanting', instruction: '{{char}} wants {{user}} physically: lingering looks and touches, closeness, the occasional deliberate move.' },
                { from: 75, name: 'Hungry', status: 'Hungry', instruction: '{{char}} wants {{user}} badly and finds it hard to hide. Desire colours most moments alone together.' },
            ],
        },
    ],
    events: {
        support: {
            description: '{{user}} helps, comforts, protects or stands up for {{char}}. (trivial: passes something wanted; severe: real risk or sacrifice for {{char}})',
            bypassCapFrom: 'severe', journalFrom: 'severe',
            effects: {
                trivial: { affection: 2 },
                minor: { affection: 4, trust: 2, kindness: 1 },
                serious: { affection: 8, trust: 5, kindness: 3 },
                severe: { affection: 15, trust: 10, kindness: 6 },
            },
        },
        patience: {
            description: '{{user}} stays kind or calm when {{char}} is rude or difficult.',
            effects: {
                trivial: { kindness: 1 },
                minor: { kindness: 2, affection: 1 },
                serious: { kindness: 4, affection: 2, trust: 1 },
                severe: { kindness: 6, affection: 4, trust: 2 },
            },
        },
        quality_time: {
            description: '{{char}} and {{user}} share a genuinely good moment together: laughing, a meal, a film, a long talk.',
            effects: {
                trivial: { affection: 1 },
                minor: { affection: 2, kindness: 1 },
                serious: { affection: 4, kindness: 2, trust: 1 },
                severe: { affection: 6, kindness: 3, trust: 2 },
            },
        },
        vulnerability: {
            description: '{{user}} or {{char}} shares something personal or painful, and the other meets it with care.',
            journalFrom: 'serious',
            effects: {
                trivial: { trust: 1 },
                minor: { trust: 3, affection: 2, love: 1 },
                serious: { trust: 6, affection: 4, love: 3 },
                severe: { trust: 10, affection: 6, love: 5 },
            },
        },
        kept_promise: {
            description: '{{user}} follows through on something {{user}} said they would do for {{char}}.',
            effects: {
                trivial: { trust: 1 },
                minor: { trust: 3 },
                serious: { trust: 6, affection: 2 },
                severe: { trust: 10, affection: 4 },
            },
        },
        apology: {
            description: '{{user}} sincerely apologises to {{char}} or makes amends for something {{user}} did.',
            effects: {
                trivial: { trust: 1 },
                minor: { trust: 2, kindness: 1 },
                serious: { trust: 5, kindness: 2, affection: 2 },
                severe: { trust: 8, kindness: 3, affection: 3 },
            },
        },
        flirting: {
            description: 'Flirting between {{char}} and {{user}}, teasing with a romantic or sexual undertone, or charged physical closeness.',
            effects: {
                trivial: { lust: 2 },
                minor: { lust: 4 },
                serious: { lust: 6, love: 1 },
                severe: { lust: 10, love: 2 },
            },
        },
        intimacy: {
            description: 'Kissing or sexual contact between {{char}} and {{user}}.',
            journalFrom: 'severe',
            effects: {
                trivial: { lust: 3 },
                minor: { lust: 5, affection: 1 },
                serious: { lust: 8, affection: 2, love: 2 },
                severe: { lust: 12, affection: 3, love: 4 },
            },
        },
        cruelty: {
            description: '{{user}} mocks, belittles, insults or humiliates {{char}}.',
            bypassCapFrom: 'serious', journalFrom: 'serious',
            effects: {
                trivial: { affection: -1 },
                minor: { affection: -3, kindness: -2, trust: -2 },
                serious: { affection: -8, kindness: -5, trust: -6 },
                severe: { affection: -20, kindness: -12, trust: -15, love: -10 },
            },
        },
        dishonesty: {
            description: '{{user}} lies to {{char}} or deceives {{char}}, and {{char}} knows or finds out. Rate how much it matters in this relationship. (trivial: a white lie about something small; severe: cheating on {{char}}, or a lie that betrays {{char}})',
            bypassCapFrom: 'serious', journalFrom: 'serious',
            effects: {
                trivial: { trust: -3 },
                minor: { trust: -8, affection: -2 },
                serious: { trust: -30, affection: -10, love: -5, kindness: -5 },
                severe: { trust: -100, affection: -40, love: -30, kindness: -25 },
            },
        },
        broken_promise: {
            description: '{{user}} fails to do something {{user}} told {{char}} they would do.',
            bypassCapFrom: 'serious', journalFrom: 'serious',
            effects: {
                trivial: { trust: -2 },
                minor: { trust: -5 },
                serious: { trust: -15, affection: -5 },
                severe: { trust: -35, affection: -15, love: -5 },
            },
        },
        rejection: {
            description: '{{user}} dismisses, ignores or pushes {{char}} away when {{char}} reaches out.',
            bypassCapFrom: 'serious', journalFrom: 'serious',
            effects: {
                trivial: { affection: -1 },
                minor: { affection: -3, trust: -1 },
                serious: { affection: -8, trust: -4, love: -3 },
                severe: { affection: -20, trust: -10, love: -10, kindness: -5 },
            },
        },
        user_takes_charge: {
            description: '{{user}} makes a decision or gives {{char}} a direction, and {{char}} goes along with it.',
            effects: {
                trivial: { dominance: -1 },
                minor: { dominance: -3 },
                serious: { dominance: -6 },
                severe: { dominance: -10 },
            },
        },
        user_yields: {
            description: '{{user}} gives way to what {{char}} wants or decides, or hands {{char}} control.',
            effects: {
                trivial: { dominance: 1 },
                minor: { dominance: 3 },
                serious: { dominance: 6 },
                severe: { dominance: 10 },
            },
        },
        char_takes_charge: {
            description: '{{char}} takes charge or insists on getting their way, when that goes beyond {{char}}\'s current Sub ↔ Dom level.',
            effects: {
                trivial: { dominance: 1 },
                minor: { dominance: 2 },
                serious: { dominance: 4 },
                severe: { dominance: 6 },
            },
        },
        char_yields: {
            description: '{{char}} gives way or submits to {{user}} unprompted, when that goes beyond {{char}}\'s current Sub ↔ Dom level.',
            effects: {
                trivial: { dominance: -1 },
                minor: { dominance: -2 },
                serious: { dominance: -4 },
                severe: { dominance: -6 },
            },
        },
    },
};

export const DEFAULT_HEADER = '[Where {{char}} stands with {{user}} now. This replaces how {{char}}\'s character sheet says {{char}} treats {{user}}. {{char}}\'s personality, history and voice stay the same. Show it in the scene; never announce the change.]';

export const DEFAULT_STRIP = [
    '/<details[\\s\\S]*?<\\/details>/gi',
    '/<scene>[\\s\\S]*?<\\/scene>/gi',
    '/<style[\\s\\S]*?<\\/style>/gi',
    '/```html[\\s\\S]*?```/gi',
    '/<[^>]+>/g',
].join('\n');

export const DEFAULT_SETTINGS = {
    version: 3,
    enabled: true,
    autoOpenWindow: true,
    showChips: true,
    library: {},              // id -> rulebook
    assignments: {},          // character avatar -> rulebook id
    judge: {
        profileId: '',
        reasoning: 'off',     // off | minimal | low | default
        temperature: 0.2,
        maxTokens: 5000,      // for the judge and the assessment; thinking counts towards it
        defaultContext: 'lean', // lean | full
        retry: true,
        includeCard: true,
        lorebook: 'constant', // constant | triggered | none
        includeHistory: true,
        historyLimit: 60,     // most visible messages the full judge reads
        strip: DEFAULT_STRIP,
    },
    assess: {
        profileId: '',        // new chats (card only); empty: same as the judge
        storyProfileId: '',   // existing chats (card and story); empty: same as new chats
        confirm: true,
        readHistory: true,
    },
    note: {
        depth: 0,
        header: DEFAULT_HEADER,
        includeNumbers: false,
    },
};

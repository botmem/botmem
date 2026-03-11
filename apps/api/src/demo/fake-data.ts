import { randomUUID } from 'crypto';

// Arabic/Emirati first names
const FIRST_NAMES = [
  'Ahmed',
  'Mohammed',
  'Ali',
  'Omar',
  'Khalid',
  'Rashid',
  'Sultan',
  'Saeed',
  'Hassan',
  'Hussein',
  'Ibrahim',
  'Youssef',
  'Tariq',
  'Faisal',
  'Nasser',
  'Hamad',
  'Majid',
  'Waleed',
  'Badr',
  'Zayed',
  'Mansour',
  'Abdulrahman',
  'Abdulaziz',
  'Saud',
  'Fahad',
  'Khaled',
  'Salman',
  'Nawaf',
  'Turki',
  'Bandar',
  'Hamdan',
  'Maktoum',
  'Thani',
  'Jassim',
  'Tamim',
  'Hazza',
  'Saif',
  'Rashed',
  'Obaid',
  'Mubarak',
  'Fatima',
  'Aisha',
  'Mariam',
  'Noura',
  'Hessa',
  'Sheikha',
  'Latifa',
  'Moza',
  'Amna',
  'Sara',
  'Layla',
  'Reem',
  'Dana',
  'Hind',
  'Maitha',
  'Shamma',
  'Ayesha',
  'Salama',
  'Jawaher',
  'Meera',
  'Khawla',
  'Rawdha',
  'Alia',
  'Maryam',
  'Lulwa',
  'Mouza',
  'Shamsa',
  'Wadha',
  'Futaim',
  'Haya',
  'Yasmin',
  'Nada',
  'Dina',
  'Lina',
  'Rana',
  'Hala',
  'Samira',
  'Karima',
  'Noor',
  'Dalal',
  'Tarek',
  'Adel',
  'Ammar',
  'Bilal',
  'Hamza',
  'Idris',
  'Ismail',
  'Jamal',
  'Karim',
  'Mazen',
  'Mostafa',
  'Nabil',
  'Rami',
  'Sami',
  'Wael',
  'Yasser',
  'Ziad',
  'Bassam',
  'Fares',
  'Ghazi',
  'Hadi',
  'Imad',
  'Jihad',
  'Louay',
  'Munir',
  'Naif',
  'Qasim',
  'Rafiq',
  'Shadi',
  'Tamer',
  'Reda',
  'Ayman',
  'Hazem',
  'Ihab',
  'Karam',
  'Marwan',
  'Osman',
  'Raed',
  'Sherif',
  'Usama',
  'Amal',
  'Bushra',
  'Deema',
  'Eman',
  'Ghada',
  'Haneen',
  'Iman',
  'Jamilah',
  'Lubna',
  'Malak',
  'Najwa',
  'Omaima',
  'Rania',
  'Sahar',
  'Taghreed',
  'Wafa',
  'Yara',
  'Zahra',
  'Abeer',
  'Basma',
  'Duha',
  'Farah',
  'Hanan',
  'Intisar',
  'Jumana',
  'Khadija',
  'Lama',
  'Maha',
  'Nisreen',
  'Raghad',
  'Suha',
  'Tamara',
  'Widad',
  'Zinab',
  'Asma',
  'Buthaina',
  'Firdaus',
  'Hadeel',
  'Maysa',
  'Ruqayya',
  'Thurayya',
  'Afra',
  'Badria',
  'Hafsa',
  'Muna',
  'Nahla',
  'Rim',
  'Sawsan',
  'Thuraya',
  'Umm',
  'Arwa',
  'Elham',
  'Fatin',
  'Habiba',
  'Ilham',
  'Lamees',
  'Manal',
  'Nawal',
  'Rabab',
  'Siham',
  'Tala',
  'Wijdan',
  'Zainab',
  'Balqees',
  'Hayat',
  'Kawther',
  'Miral',
  'Nada',
  'Rasha',
  'Souad',
  'Thana',
  'Abrar',
  'Anoud',
  'Bayan',
  'Ghaida',
  'Hajar',
  'Juwayriya',
  'Khulood',
  'Mashael',
  'Nouf',
];

// Arabic/Emirati family names
const LAST_NAMES = [
  'Al Maktoum',
  'Al Nahyan',
  'Al Thani',
  'Al Saud',
  'Al Sabah',
  'Al Khalifa',
  'Al Qasimi',
  'Al Sharqi',
  'Al Nuaimi',
  'Al Mualla',
  'Al Falasi',
  'Al Ketbi',
  'Al Mazrouei',
  'Al Dhaheri',
  'Al Mansoori',
  'Al Shamsi',
  'Al Hammadi',
  'Al Zaabi',
  'Al Mheiri',
  'Al Suwaidi',
  'Al Kaabi',
  'Al Neyadi',
  'Al Blooshi',
  'Al Ameri',
  'Al Marri',
  'Al Kuwaiti',
  'Al Hashimi',
  'Al Tayer',
  'Al Ghurair',
  'Al Futtaim',
  'Al Habtoor',
  'Al Rostamani',
  'Al Masaood',
  'Al Jaber',
  'Al Otaiba',
  'Al Rumaithi',
  'Al Balooshi',
  'Al Hosani',
  'Al Khoori',
  'Al Marzooqi',
  'Al Shehhi',
  'Al Qemzi',
  'Al Darmaki',
  'Al Hammouri',
  'Al Kindi',
  'Al Rashdi',
  'Al Wahaibi',
  'Al Junaibi',
  'Bin Zayed',
  'Bin Rashid',
  'Bin Mohammed',
  'Bin Sultan',
  'Bin Saeed',
  'Bin Hamad',
  'Bin Khalifa',
  'Bin Ahmed',
  'El Sayed',
  'El Masri',
  'El Khatib',
  'El Amin',
  'El Tayeb',
  'El Nour',
  'El Fadl',
  'El Sharif',
  'Abdulla',
  'Mahmoud',
  'Mustafa',
  'Saleh',
  'Younis',
  'Darwish',
  'Khamis',
  'Obaidli',
  'Bukhari',
  'Qureshi',
  'Siddiqui',
  'Farooqi',
  'Ansari',
  'Rizvi',
  'Haider',
  'Naqvi',
  'Haddad',
  'Najjar',
  'Sabbagh',
  'Khoury',
  'Tabbara',
  'Bitar',
  'Hariri',
  'Gemayel',
  'Barghouti',
  'Tamimi',
  'Arafat',
  'Masri',
  'Khalil',
  'Issa',
  'Hanna',
  'Bishara',
  'Bashar',
  'Kanaan',
  'Awad',
  'Jbara',
  'Odeh',
  'Moussa',
  'Nassar',
  'Saad',
  'Gharib',
  'Shukri',
  'Tawfiq',
  'Labib',
  'Fikri',
  'Rushdi',
  'Hilmi',
  'Sabri',
  'Habibi',
  'Shaheen',
  'Diab',
  'Khalaf',
  'Yaqoub',
  'Daoud',
  'Hamed',
  'Ashraf',
  'Bakr',
  'Barakat',
  'Farouk',
  'Ghanem',
  'Jabr',
  'Lutfi',
  'Mahdi',
  'Naji',
  'Qadri',
  'Radi',
  'Safar',
  'Talal',
  'Wazir',
  'Zahir',
  'Abbas',
  'Badawi',
  'Chehab',
  'Dajani',
  'Fahmi',
  'Habash',
  'Jamil',
  'Kassab',
  'Mansur',
  'Nasser',
  'Othman',
  'Qabbani',
  'Rahal',
  'Samaha',
  'Touma',
  'Wehbe',
  'Yazbek',
  'Zogby',
  'Al Ali',
  'Al Hassan',
  'Al Hussein',
  'Al Ibrahim',
  'Al Omar',
  'Al Youssef',
  'Al Ahmad',
  'Al Hamad',
];

// UAE-based companies
const COMPANIES = [
  'Etisalat Digital',
  'du Telecom',
  'Emirates NBD',
  'Mashreq Bank',
  'ADNOC Group',
  'Emaar Properties',
  'Aldar Properties',
  'DEWA Solutions',
  'Mubadala Ventures',
  'Abu Dhabi Investment',
  'Dubai Holding',
  'Majid Al Futtaim',
  'Al Ghurair Group',
  'Chalhoub Group',
  'Al Tayer Group',
  'Landmark Group',
  'Noon.com',
  'Careem Technologies',
  'Talabat Digital',
  'Kitopi Cloud Kitchen',
  'G42 AI',
  'Hub71 Ventures',
  'DIFC Innovation',
  'Masdar Clean Energy',
  'Edge Group Defence',
  'Bayanat AI',
  'Presight AI',
  'Technology Innovation Institute',
  'Injazat Data Systems',
  'SmartWorld',
];

// UAE company domains
const DOMAINS = [
  'etisalat-digital.ae',
  'du-tech.ae',
  'emiratesnbd.co',
  'mashreq-digital.ae',
  'adnoc-tech.ae',
  'emaar-digital.ae',
  'aldar-tech.ae',
  'dewa-solutions.ae',
  'mubadala-vc.ae',
  'adia-tech.ae',
  'dubaiholding.co',
  'maf-digital.ae',
  'ghurair-tech.ae',
  'chalhoub-digital.ae',
  'altayer-tech.ae',
  'landmark-digital.ae',
  'noon-tech.ae',
  'careem-eng.ae',
  'talabat-tech.ae',
  'kitopi-cloud.ae',
  'g42.ai',
  'hub71-vc.ae',
  'difc-innov.ae',
  'masdar-energy.ae',
  'edge-defence.ae',
  'bayanat.ai',
  'presight.ai',
  'tii-research.ae',
  'injazat-data.ae',
  'smartworld.ae',
];

// UAE cities and neighborhoods
const CITIES = [
  'Dubai',
  'Abu Dhabi',
  'Sharjah',
  'Ajman',
  'Ras Al Khaimah',
  'Fujairah',
  'Umm Al Quwain',
  'Al Ain',
  'Dubai Marina',
  'Downtown Dubai',
  'Jumeirah',
  'Business Bay',
  'DIFC',
  'Yas Island',
  'Saadiyat Island',
  'Al Reem Island',
  'Khalifa City',
  'Masdar City',
  'JBR',
  'Palm Jumeirah',
  'Arabian Ranches',
  'Dubai Hills',
  'Creek Harbour',
  'Corniche Abu Dhabi',
  'Al Maryah Island',
  'Hatta',
  'Khor Fakkan',
  'Dibba',
  'Silicon Oasis',
  'Internet City',
  'Media City',
  'Knowledge Park',
  'Al Barsha',
];

// UAE venues and landmarks
const VENUES = [
  'Burj Khalifa',
  'Dubai Mall',
  'Mall of the Emirates',
  'Louvre Abu Dhabi',
  'Sheikh Zayed Grand Mosque',
  'Global Village',
  'Dubai Frame',
  'Ain Dubai',
  'Museum of the Future',
  'Expo City',
  'Yas Mall',
  'Ferrari World',
  'Warner Bros World',
  'Qasr Al Watan',
  'Emirates Palace',
  'Atlantis The Palm',
  'Madinat Jumeirah',
  'La Mer Beach',
  'Kite Beach',
  'Al Mamzar Park',
  'Dubai Opera',
  'Alserkal Avenue',
  'City Walk',
  'Bluewaters Island',
  'The Walk JBR',
  'Qasr Al Hosn',
  'Mangrove National Park',
  'Jebel Jais',
  'Hatta Dam',
  'Al Fahidi District',
];

const SLACK_CHANNELS = [
  '#engineering',
  '#product',
  '#design',
  '#ops-alerts',
  '#general',
  '#backend',
  '#frontend',
  '#devops',
  '#data-science',
  '#marketing',
  '#incidents',
  '#deployments',
  '#code-review',
  '#random',
  '#announcements',
  '#customer-success',
  '#sales',
  '#security',
  '#infra',
  '#mobile',
];

const SUBJECTS_WORK = [
  'Q{q} Budget Review',
  'Sprint {n} Retrospective',
  'Product Roadmap Update',
  'New Feature Proposal: {feature}',
  'Performance Review Schedule',
  'Team Offsite Planning',
  'Client Meeting Follow-up',
  'Security Audit Results',
  'Infrastructure Migration Plan',
  'Quarterly OKR Check-in',
  'Design System Updates',
  'API Documentation Review',
  'Database Migration Notice',
  'Release {version} Notes',
  'Onboarding Checklist Update',
];

const FEATURES = [
  'real-time collaboration',
  'dark mode',
  'export to PDF',
  'two-factor auth',
  'custom dashboards',
  'webhook integrations',
  'batch processing',
  'search filters',
  'notification preferences',
  'audit logging',
  'SSO integration',
  'mobile app',
];

const NEWSLETTER_SUBJECTS = [
  'Weekly Digest: Top Stories',
  'Your Monthly Summary',
  'Industry Trends Report',
  'New Features This Week',
  'Community Highlights',
  'Tech News Roundup',
  'Product Updates & Tips',
  'Upcoming Events & Webinars',
  'Best Practices Guide',
  'Year in Review: Key Metrics',
];

const RECEIPT_VENDORS = [
  'Amazon.ae',
  'Apple',
  'Google Cloud',
  'AWS',
  'Noon.com',
  'Talabat',
  'Careem',
  'Deliveroo UAE',
  'Namshi',
  'Sharaf DG',
  'Etisalat',
  'du',
  'DEWA',
  'Spotify',
  'Netflix',
  'OSN+',
  'StarzPlay',
  'Anghami',
];

// Helper functions
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomDate(daysAgo: number): Date {
  const now = Date.now();
  const offset = Math.random() * daysAgo * 24 * 60 * 60 * 1000;
  return new Date(now - offset);
}

// UAE phone number generator (+971 5X XXX XXXX)
function uaePhone(): string {
  return `+9715${randInt(0, 9)}${randInt(1000000, 9999999)}`;
}

// Contact generation
export interface FakeContact {
  id: string;
  displayName: string;
  entityType: 'person' | 'group' | 'organization';
  identifiers: Array<{ type: string; value: string; connectorType: string }>;
}

export function generateContacts(count: number): FakeContact[] {
  const contacts: FakeContact[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    let firstName: string, lastName: string, fullName: string;
    do {
      firstName = pick(FIRST_NAMES);
      lastName = pick(LAST_NAMES);
      fullName = `${firstName} ${lastName}`;
    } while (usedNames.has(fullName));
    usedNames.add(fullName);

    const entityType: 'person' | 'group' | 'organization' =
      i < 85 ? 'person' : i < 95 ? 'group' : 'organization';

    const domain = pick(DOMAINS);
    const identifiers: FakeContact['identifiers'] = [];

    if (entityType === 'person') {
      identifiers.push({
        type: 'email',
        value: `${firstName.toLowerCase()}.${lastName.toLowerCase().replace(/ /g, '')}@${domain}`,
        connectorType: 'gmail',
      });
      if (Math.random() > 0.4) {
        identifiers.push({
          type: 'phone',
          value: uaePhone(),
          connectorType: 'whatsapp',
        });
      }
      if (Math.random() > 0.5) {
        identifiers.push({
          type: 'slack_id',
          value: `U${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`,
          connectorType: 'slack',
        });
      }
    } else if (entityType === 'group') {
      fullName = `${pick(['Engineering', 'Product', 'Design', 'Marketing', 'Sales', 'Ops', 'Leadership', 'Data', 'QA', 'Platform'])} Team`;
      if (usedNames.has(fullName)) {
        fullName = `${fullName} ${i}`;
      }
      usedNames.add(fullName);
      identifiers.push({
        type: 'slack_id',
        value: `C${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`,
        connectorType: 'slack',
      });
    } else {
      fullName = pick(COMPANIES);
      if (usedNames.has(fullName)) {
        fullName = `${fullName} LLC`;
      }
      usedNames.add(fullName);
      identifiers.push({
        type: 'email',
        value: `info@${domain}`,
        connectorType: 'gmail',
      });
    }

    contacts.push({
      id: randomUUID(),
      displayName: fullName,
      entityType,
      identifiers,
    });
  }

  return contacts;
}

// Memory template generation
export interface FakeMemory {
  id: string;
  connectorType: string;
  sourceType: string;
  sourceId: string;
  text: string;
  eventTime: Date;
  entities: Array<{ type: string; value: string }>;
  claims: Array<{ claim: string; confidence: number }>;
  factuality: { label: string; confidence: number; rationale: string };
  weights: {
    semantic: number;
    rerank: number;
    recency: number;
    importance: number;
    trust: number;
    final: number;
  };
  metadata: Record<string, unknown>;
  contactIndices: number[];
  contactRoles: string[];
}

function generateGmailMemory(contacts: FakeContact[]): FakeMemory {
  const id = randomUUID();
  const sender = contacts[randInt(0, Math.min(contacts.length - 1, 84))];
  const recipients = pickN(
    contacts.filter((c) => c.entityType === 'person' && c.id !== sender.id),
    randInt(1, 3),
  );

  const category = pick(['work', 'receipt', 'newsletter', 'travel', 'invoice']);
  let subject: string, body: string, entities: FakeMemory['entities'], claims: FakeMemory['claims'];

  switch (category) {
    case 'work': {
      const template = pick(SUBJECTS_WORK);
      subject = template
        .replace('{q}', String(randInt(1, 4)))
        .replace('{n}', String(randInt(1, 30)))
        .replace('{feature}', pick(FEATURES))
        .replace('{version}', `${randInt(1, 5)}.${randInt(0, 9)}.${randInt(0, 20)}`);
      const company = pick(COMPANIES);
      body = `Hi team,\n\nFollowing up on our discussion about ${subject.toLowerCase()}. ${pick([
        `The deadline is set for next ${pick(['Sunday', 'Tuesday', 'Wednesday'])}.`,
        'We need to finalize the proposal by end of week.',
        `${company} has confirmed their participation.`,
        'Please review the attached document and share your feedback.',
        `The next sync is scheduled for ${pick(['Sunday', 'Tuesday'])} at ${randInt(9, 17)}:00 GST.`,
      ])}\n\nBest regards,\n${sender.displayName}`;
      entities = [
        { type: 'person', value: sender.displayName },
        ...recipients.map((r) => ({ type: 'person', value: r.displayName })),
        { type: 'organization', value: company },
      ];
      claims = [
        {
          claim: `${sender.displayName} sent email about ${subject}`,
          confidence: randFloat(0.7, 0.95),
        },
      ];
      break;
    }
    case 'receipt': {
      const vendor = pick(RECEIPT_VENDORS);
      const amount = `AED ${randInt(20, 2000)}.${String(randInt(0, 99)).padStart(2, '0')}`;
      subject = `Receipt from ${vendor} - ${amount}`;
      body = `Thank you for your purchase!\n\nOrder confirmation from ${vendor}\nAmount: ${amount}\nDate: ${new Date().toLocaleDateString()}\n\nThis is an automated receipt.`;
      entities = [
        { type: 'organization', value: vendor },
        { type: 'amount', value: amount },
      ];
      claims = [{ claim: `Purchase of ${amount} from ${vendor}`, confidence: 0.95 }];
      break;
    }
    case 'newsletter': {
      subject = pick(NEWSLETTER_SUBJECTS);
      const org = pick(COMPANIES);
      body = `${subject}\n\n${pick([
        "Here are this week's top highlights and updates from the UAE tech scene.",
        'Check out the latest trends and insights from our team in the Gulf region.',
        "We've curated the most important updates for you.",
      ])}\n\nFrom the ${org} team.`;
      entities = [{ type: 'organization', value: org }];
      claims = [{ claim: `Newsletter received from ${org}`, confidence: 0.9 }];
      break;
    }
    case 'travel': {
      const city = pick(CITIES);
      const airline = pick([
        'Emirates',
        'Etihad Airways',
        'flydubai',
        'Air Arabia',
        'Wizz Air Abu Dhabi',
        'SaudiGulf Airlines',
      ]);
      subject = `Travel Confirmation - ${city}`;
      body = `Your travel itinerary:\n\nDestination: ${city}\nAirline: ${airline}\nConfirmation: ${randomUUID().slice(0, 8).toUpperCase()}\nDeparture: ${randomDate(30).toLocaleDateString()}\n\nHave a great trip!`;
      entities = [
        { type: 'location', value: city },
        { type: 'organization', value: airline },
      ];
      claims = [{ claim: `Travel booked to ${city} via ${airline}`, confidence: 0.95 }];
      break;
    }
    default: {
      const company = pick(COMPANIES);
      const amount = `AED ${randInt(500, 50000)}.00`;
      subject = `Invoice #${randInt(1000, 9999)} from ${company}`;
      body = `Invoice Details:\n\nFrom: ${company}\nAmount Due: ${amount}\nDue Date: ${randomDate(14).toLocaleDateString()}\nPayment Terms: Net 30\n\nPlease process at your earliest convenience.`;
      entities = [
        { type: 'organization', value: company },
        { type: 'amount', value: amount },
      ];
      claims = [{ claim: `Invoice of ${amount} from ${company}`, confidence: 0.9 }];
      break;
    }
  }

  const contactIndices = [
    contacts.indexOf(sender),
    ...recipients.map((r) => contacts.indexOf(r)),
  ].filter((i) => i >= 0);
  const contactRoles = ['sender', ...recipients.map(() => 'recipient')];

  return {
    id,
    connectorType: 'gmail',
    sourceType: 'email',
    sourceId: `demo-gmail-${id}`,
    text: `Subject: ${subject}\n\n${body}`,
    eventTime: randomDate(90),
    entities,
    claims,
    factuality: {
      label: pick(['FACT', 'UNVERIFIED']),
      confidence: randFloat(0.6, 0.95),
      rationale: 'Demo data',
    },
    weights: {
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: randFloat(0.3, 0.8),
      trust: 0.7,
      final: 0,
    },
    metadata: {
      subject,
      category,
      from: sender.displayName,
      to: recipients.map((r) => r.displayName),
    },
    contactIndices,
    contactRoles,
  };
}

function generateSlackMemory(contacts: FakeContact[]): FakeMemory {
  const id = randomUUID();
  const sender = contacts[randInt(0, Math.min(contacts.length - 1, 84))];
  const channel = pick(SLACK_CHANNELS);

  const templates = [
    `Just deployed ${pick(['v' + randInt(1, 5) + '.' + randInt(0, 9), 'the hotfix', 'the migration'])} to ${pick(['staging', 'production', 'canary'])}. All green so far.`,
    `Heads up: ${pick(['database migration', 'API deprecation', 'SSL cert renewal', 'dependency update'])} scheduled for ${pick(['tomorrow', 'next week', 'after the weekend'])}. Details in the doc.`,
    `Can someone review PR #${randInt(100, 999)}? It's the ${pick(FEATURES)} implementation.`,
    `FYI: ${pick(COMPANIES)} reached out about ${pick(['a partnership', 'an integration', 'sponsoring GITEX', 'a custom deployment'])}. Scheduling a call.`,
    `@here Alert: ${pick(['High CPU on prod-web-3', 'Elevated error rate on /api/search', 'Redis latency spike', 'Disk usage at 85% on db-primary'])}. Looking into it.`,
    `Shipped ${pick(FEATURES)} to beta users. Initial feedback looks ${pick(['positive', 'promising', 'mixed - need to iterate', 'great'])}! Yalla let's ship it.`,
    `Quick update: ${pick(['standup moved to 10am', 'demo day is Thursday', 'all-hands at 3pm', 'sprint review tomorrow'])}. Check calendar.`,
    `Found a ${pick(['race condition', 'memory leak', 'null pointer', 'deadlock', 'N+1 query'])} in the ${pick(['auth service', 'payment module', 'search indexer', 'notification system'])}. Working on a fix.`,
    `The ${pick(['monitoring dashboard', 'CI pipeline', 'load balancer', 'cache layer'])} ${pick(['is acting up', 'needs attention', 'was misconfigured', 'has been upgraded'])}. ${pick(['Will fix after lunch', 'PR incoming', 'Deployed the fix', 'Needs discussion'])}.`,
    `Reminder: ${pick(['code freeze', 'security audit', 'dependency review', 'GITEX prep'])} starts ${pick(['Sunday', 'next sprint', 'end of month'])}. Please wrap up open PRs.`,
  ];

  const text = `[${channel}] ${sender.displayName}: ${pick(templates)}`;
  const mentioned = pickN(
    contacts.filter((c) => c.entityType === 'person' && c.id !== sender.id),
    randInt(0, 2),
  );

  return {
    id,
    connectorType: 'slack',
    sourceType: 'message',
    sourceId: `demo-slack-${id}`,
    text,
    eventTime: randomDate(90),
    entities: [
      { type: 'person', value: sender.displayName },
      ...mentioned.map((m) => ({ type: 'person', value: m.displayName })),
      { type: 'channel', value: channel },
    ],
    claims: [{ claim: `${sender.displayName} posted in ${channel}`, confidence: 0.85 }],
    factuality: {
      label: 'UNVERIFIED',
      confidence: 0.6,
      rationale: 'Slack message - single source',
    },
    weights: {
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: randFloat(0.2, 0.7),
      trust: 0.6,
      final: 0,
    },
    metadata: { channel, sender: sender.displayName },
    contactIndices: [contacts.indexOf(sender), ...mentioned.map((m) => contacts.indexOf(m))].filter(
      (i) => i >= 0,
    ),
    contactRoles: ['sender', ...mentioned.map(() => 'mentioned')],
  };
}

function generateWhatsAppMemory(contacts: FakeContact[]): FakeMemory {
  const id = randomUUID();
  const sender = contacts[randInt(0, Math.min(contacts.length - 1, 84))];

  const templates = [
    `Yalla are you free ${pick(['tonight', 'this weekend', 'tomorrow', 'on Friday'])}? Want to ${pick(['grab shawarma', 'go to the mall', 'watch the match', 'check out that new cafe in JBR'])}?`,
    `Habibi did you see this? ${pick(['So funny wallah', 'This is so us', 'Remember when we did this?', 'Sending good vibes'])}`,
    `Happy ${pick(['Eid', 'National Day', 'birthday', 'anniversary'])}! ${pick(['Eid Mubarak', 'Hope you have an amazing day', 'Kul 3am w enta b kheir', 'Mabrook!'])}`,
    `Did you see the ${pick(['news about Dubai', 'match last night', 'new restaurant on Sheikh Zayed', 'announcement from GITEX', 'photos from the trip'])}? ${pick(['Incredible!', 'Yalla we have to go', 'We need to talk about this', 'Thoughts?'])}`,
    `Running ${pick(['10', '15', '20', '30'])} minutes late. ${pick(['Traffic on Sheikh Zayed is crazy', 'Meeting ran over', 'Sorry habibi!', 'Almost at the metro'])}`,
    `Can you pick up ${pick(['hummus', 'bread from the bakery', 'groceries from Carrefour', 'the kids from school', 'my package from the mailbox'])} on your way home?`,
    `Family iftar at ${pick(VENUES)} on ${pick(['Friday', 'Saturday', 'Thursday evening'])}. Everyone confirmed! ${pick(['See you there', 'Yalla la t2akhar', 'Bring dessert?', '7pm sharp'])}`,
    `The ${pick(['AC technician', 'plumber', 'electrician', 'Noon delivery'])} is coming ${pick(['tomorrow morning', 'at 2pm', 'between 10-12', 'this afternoon'])}. Can someone be home?`,
    `${pick(['Mama', 'Baba', 'Teta', 'Khalo Ahmed', 'Amo Rashid'])} says ${pick(['hi', 'thank you for the gift', 'the mansaf was amazing', 'come visit soon'])}!`,
    `Moving to ${pick(['Dubai Marina', 'JVC', 'Abu Dhabi', 'Al Ain', 'Sharjah'])} next month! ${pick(['So excited', 'Inshallah it goes well', 'Will miss the neighborhood', 'New chapter!'])}`,
  ];

  const text = `${sender.displayName}: ${pick(templates)}`;

  return {
    id,
    connectorType: 'whatsapp',
    sourceType: 'message',
    sourceId: `demo-wa-${id}`,
    text,
    eventTime: randomDate(90),
    entities: [{ type: 'person', value: sender.displayName }],
    claims: [{ claim: `WhatsApp message from ${sender.displayName}`, confidence: 0.8 }],
    factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: 'Personal message' },
    weights: {
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: randFloat(0.2, 0.6),
      trust: 0.5,
      final: 0,
    },
    metadata: { sender: sender.displayName, chat: pick(['private', 'group']) },
    contactIndices: [contacts.indexOf(sender)],
    contactRoles: ['sender'],
  };
}

function generateIMessageMemory(contacts: FakeContact[]): FakeMemory {
  const id = randomUUID();
  const sender = contacts[randInt(0, Math.min(contacts.length - 1, 84))];

  const templates = [
    `${pick(['Sure', 'Sounds good', 'OK yalla', 'Got it', 'Will do'])}! ${pick(['See you then', 'On my way', 'Thanks habibi!', 'Perfect'])}`,
    `Can you send me the ${pick(['address', 'link', 'recipe for the machboos', 'document', 'photo from Friday'])}?`,
    `Just finished ${pick(['the meeting', 'my workout at Fitness First', 'cooking dinner', 'that book', 'the project'])}. ${pick(['It went well alhamdulillah', 'Feeling great', 'Finally!', 'That was intense'])}`,
    `Don't forget about ${pick(['the appointment at Mediclinic', "mama's birthday", 'the reservation at Zuma', 'the deadline', 'grocery shopping at LuLu'])} ${pick(['tomorrow', 'this week', 'on Friday', 'at 3pm'])}`,
    `${pick(['Loved', 'Really enjoyed', 'Thanks for'])} ${pick(['the dinner at Salt', 'the movie at Vox', 'hanging out at the Corniche', 'the recommendation', 'the gift'])}! Let's do it again soon`,
    `Is ${pick(['Carrefour', 'the office', 'the school', 'that restaurant in DIFC', 'the gym'])} open ${pick(['today', 'right now', 'on Fridays', 'until late'])}?`,
    `Need to reschedule ${pick(['our lunch', 'the call', 'coffee at % Arabica', 'the meetup', 'the appointment'])}. How about ${pick(['Thursday', 'next week', 'tomorrow instead', 'the weekend'])}?`,
    `Check out this ${pick(['article about UAE tech', 'podcast', 'show on OSN', 'place in Al Quoz', 'app'])} - ${pick(["you'll love it", 'reminds me of our conversation', 'really interesting', 'thought-provoking'])}`,
  ];

  const text = `${sender.displayName}: ${pick(templates)}`;

  return {
    id,
    connectorType: 'imessage',
    sourceType: 'message',
    sourceId: `demo-imsg-${id}`,
    text,
    eventTime: randomDate(90),
    entities: [{ type: 'person', value: sender.displayName }],
    claims: [{ claim: `iMessage from ${sender.displayName}`, confidence: 0.8 }],
    factuality: { label: 'UNVERIFIED', confidence: 0.5, rationale: 'Personal message' },
    weights: {
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: randFloat(0.2, 0.5),
      trust: 0.6,
      final: 0,
    },
    metadata: { sender: sender.displayName },
    contactIndices: [contacts.indexOf(sender)],
    contactRoles: ['sender'],
  };
}

function generatePhotoMemory(contacts: FakeContact[]): FakeMemory {
  const id = randomUUID();
  const city = pick(CITIES);
  const venue = pick(VENUES);
  const people = pickN(
    contacts.filter((c) => c.entityType === 'person'),
    randInt(0, 3),
  );

  const templates = [
    `Photo taken at ${venue}, ${city}. ${pick(['Sunny day', 'Beautiful sunset over the Gulf', 'Perfect desert weather', 'Golden hour'])}. ${people.length > 0 ? `With ${people.map((p) => p.displayName).join(', ')}.` : 'Solo adventure.'}`,
    `Screenshot of ${pick(['a recipe for kunafa', 'flight details on Emirates', 'a conversation', 'directions to ' + venue, 'meeting notes', 'a funny meme'])}`,
    `Document scan: ${pick(['Emirates ID', 'insurance card', 'receipt from ' + pick(RECEIPT_VENDORS), 'business card', 'visa document'])}`,
    `${pick(['Sunset', 'Skyline', 'Street scene', 'Food', 'Group photo', 'Selfie'])} at ${venue}, ${city}. ${pick(['Amazing view of the skyline!', 'Great memories', 'What a night!', 'Worth the trip'])}`,
    `Event: ${pick(['GITEX conference', 'wedding', 'birthday party', 'team offsite at the desert', 'concert at Coca-Cola Arena', 'art exhibition at Alserkal'])} at ${venue}. ${people.length > 0 ? people.map((p) => p.displayName).join(', ') + ' were there.' : ''}`,
  ];

  const text = pick(templates);

  return {
    id,
    connectorType: 'photos-immich',
    sourceType: 'photo',
    sourceId: `demo-photo-${id}`,
    text,
    eventTime: randomDate(90),
    entities: [
      { type: 'location', value: `${venue}, ${city}` },
      ...people.map((p) => ({ type: 'person', value: p.displayName })),
    ],
    claims:
      people.length > 0
        ? [
            {
              claim: `Photo with ${people.map((p) => p.displayName).join(', ')} at ${venue}`,
              confidence: 0.7,
            },
          ]
        : [{ claim: `Photo taken at ${venue}, ${city}`, confidence: 0.8 }],
    factuality: { label: 'FACT', confidence: 0.9, rationale: 'Photo metadata' },
    weights: {
      semantic: 0,
      rerank: 0,
      recency: 0,
      importance: randFloat(0.3, 0.7),
      trust: 0.8,
      final: 0,
    },
    metadata: { location: `${venue}, ${city}`, people: people.map((p) => p.displayName) },
    contactIndices: people.map((p) => contacts.indexOf(p)).filter((i) => i >= 0),
    contactRoles: people.map(() => 'mentioned'),
  };
}

export function generateMemories(
  contacts: FakeContact[],
  counts: { gmail: number; slack: number; whatsapp: number; imessage: number; photos: number },
): FakeMemory[] {
  const memories: FakeMemory[] = [];
  const generators: [number, (contacts: FakeContact[]) => FakeMemory][] = [
    [counts.gmail, generateGmailMemory],
    [counts.slack, generateSlackMemory],
    [counts.whatsapp, generateWhatsAppMemory],
    [counts.imessage, generateIMessageMemory],
    [counts.photos, generatePhotoMemory],
  ];

  for (const [count, generator] of generators) {
    for (let i = 0; i < count; i++) {
      memories.push(generator(contacts));
    }
  }

  return memories;
}

// Generate random normalized vector
export function randomVector(dimensions: number): number[] {
  const vec = Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / magnitude);
}

// PII scanner
export function scanForPII(texts: string[]): { clean: boolean; flagged: string[] } {
  const flagged: string[] = [];
  const realEmailPattern = /@(gmail|yahoo|hotmail|outlook|icloud|protonmail)\.(com|net|org)/i;
  const knownNames = ['amr essam', 'amroessams'];

  for (const text of texts) {
    if (realEmailPattern.test(text)) {
      flagged.push(`Real email domain detected: ${text.match(realEmailPattern)?.[0]}`);
    }
    for (const name of knownNames) {
      if (text.toLowerCase().includes(name)) {
        flagged.push(`Known name detected: ${name}`);
      }
    }
  }

  return { clean: flagged.length === 0, flagged };
}

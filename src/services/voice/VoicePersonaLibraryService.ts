import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error';
import { TenantConfigCache } from '../cache/TenantConfigCache';

export type VoiceAssignmentMode =
  | 'FIXED'
  | 'ROTATION_POOL'
  | 'CHANNEL_SPECIFIC'
  | 'TIME_OF_DAY'
  | 'CUSTOMER_SEGMENT';

export type SpeakingPace = 'slow' | 'normal' | 'fast';

export interface VoicePersonaCatalogItem {
  id: string;
  name: string;
  category:
    | 'Professional — Formal'
    | 'Warm — Conversational'
    | 'Empathetic — Calm'
    | 'Consultative — Confident'
    | 'Energetic — Engaging'
    | 'Regional — Localised';
  gender: 'male' | 'female' | 'neutral';
  ageRange: 'Young' | 'Mid' | 'Mature';
  characteristics: string;
  supportedLanguages: string[];
  baseProviderVoice: string;
  defaultSpeed: number;
  defaultWarmth: number;
  pitchHz: number;
}

export interface AgentVoiceAssignmentConfig {
  mode: VoiceAssignmentMode;
  fixedVoiceId: string;
  rotationPoolIds: string[];
  rotationCursor: number;
  channelMap: {
    web_voice: string;
    outbound_campaign: string;
    whatsapp_voice: string;
  };
  timeWindowMap: {
    morningVoiceId: string; // 09:00 - 13:00
    afternoonEveningVoiceId: string; // 13:00 - 20:00
    afterHoursVoiceId: string; // 20:00 - 09:00
  };
  segmentMap: {
    premium: string;
    standard: string;
  };
  shortlistedVoiceIds: string[];
  customBrandName: string;
}

export const V3C_VOICE_LIBRARY: VoicePersonaCatalogItem[] = [
  {
    id: 'shimmer',
    name: 'Shimmer (Amina)',
    category: 'Professional — Formal',
    gender: 'female',
    ageRange: 'Mid',
    characteristics: 'Clear, authoritative, measured. Suited for policy servicing, compliance & banking.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'shimmer',
    defaultSpeed: 1.0,
    defaultWarmth: 0.55,
    pitchHz: 215,
  },
  {
    id: 'onyx',
    name: 'Onyx (Tariq)',
    category: 'Professional — Formal',
    gender: 'male',
    ageRange: 'Mature',
    characteristics: 'Deep, executive, reassuringly formal. Ideal for corporate & institutional inquiries.',
    supportedLanguages: ['English', 'Urdu', 'Arabic'],
    baseProviderVoice: 'onyx',
    defaultSpeed: 0.95,
    defaultWarmth: 0.5,
    pitchHz: 115,
  },
  {
    id: 'alloy',
    name: 'Alloy (Sana)',
    category: 'Warm — Conversational',
    gender: 'female',
    ageRange: 'Young',
    characteristics: 'Friendly, approachable, natural cadence. Suited for FAQ, triage & general support.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'alloy',
    defaultSpeed: 1.0,
    defaultWarmth: 0.75,
    pitchHz: 225,
  },
  {
    id: 'echo',
    name: 'Echo (Bilal)',
    category: 'Warm — Conversational',
    gender: 'male',
    ageRange: 'Mid',
    characteristics: 'Balanced, conversational warmth. Ideal for everyday customer assistance.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'echo',
    defaultSpeed: 1.0,
    defaultWarmth: 0.7,
    pitchHz: 135,
  },
  {
    id: 'sage',
    name: 'Sage (Zainab)',
    category: 'Empathetic — Calm',
    gender: 'female',
    ageRange: 'Mid',
    characteristics: 'Soft, reassuring, patient. Designed for claims triage, complaints & sensitive topics.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'sage',
    defaultSpeed: 0.92,
    defaultWarmth: 0.85,
    pitchHz: 205,
  },
  {
    id: 'ballad',
    name: 'Ballad (Hamza)',
    category: 'Empathetic — Calm',
    gender: 'male',
    ageRange: 'Mid',
    characteristics: 'Smooth, unhurried, de-escalating tone for medical & motor claims assistance.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'ballad',
    defaultSpeed: 0.95,
    defaultWarmth: 0.8,
    pitchHz: 130,
  },
  {
    id: 'coral',
    name: 'Coral (Mehreen)',
    category: 'Consultative — Confident',
    gender: 'female',
    ageRange: 'Mid',
    characteristics: 'Persuasive, knowledgeable, engaging. Suited for pre-sales & wealth/takaful advisory.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'coral',
    defaultSpeed: 1.02,
    defaultWarmth: 0.7,
    pitchHz: 220,
  },
  {
    id: 'cedar',
    name: 'Cedar (Kamran)',
    category: 'Consultative — Confident',
    gender: 'male',
    ageRange: 'Mature',
    characteristics: 'Confident, articulate advisor persona for investment & enterprise consultations.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'cedar',
    defaultSpeed: 1.0,
    defaultWarmth: 0.65,
    pitchHz: 122,
  },
  {
    id: 'nova',
    name: 'Nova (Hira)',
    category: 'Energetic — Engaging',
    gender: 'female',
    ageRange: 'Young',
    characteristics: 'Upbeat, dynamic, enthusiastic. Suited for outbound campaigns, promotions & welcome calls.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'nova',
    defaultSpeed: 1.08,
    defaultWarmth: 0.75,
    pitchHz: 235,
  },
  {
    id: 'verse',
    name: 'Verse (Daniyal)',
    category: 'Energetic — Engaging',
    gender: 'male',
    ageRange: 'Young',
    characteristics: 'Dynamic, crisp delivery for proactive renewal reminders & product launches.',
    supportedLanguages: ['English', 'Urdu'],
    baseProviderVoice: 'verse',
    defaultSpeed: 1.05,
    defaultWarmth: 0.68,
    pitchHz: 145,
  },
  {
    id: 'marin',
    name: 'Marin (Marvi — Regional)',
    category: 'Regional — Localised',
    gender: 'female',
    ageRange: 'Mid',
    characteristics: 'Native accent and cadence for regional language deployment (Urdu, Sindhi, Punjabi).',
    supportedLanguages: ['Urdu', 'Sindhi', 'Punjabi', 'English'],
    baseProviderVoice: 'marin',
    defaultSpeed: 0.98,
    defaultWarmth: 0.82,
    pitchHz: 218,
  },
  {
    id: 'ash',
    name: 'Ash (Sheraz — Regional)',
    category: 'Regional — Localised',
    gender: 'male',
    ageRange: 'Mid',
    characteristics: 'Expressive regional cadence tailored for Pashto, Punjabi, Urdu & Arabic callers.',
    supportedLanguages: ['Urdu', 'Pashto', 'Punjabi', 'Arabic', 'English'],
    baseProviderVoice: 'ash',
    defaultSpeed: 0.98,
    defaultWarmth: 0.78,
    pitchHz: 138,
  },
];

function buildSilentOrToneWavDataUri(freqHz: number, durationSec = 1.5, paceMultiplier = 1.0): string {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = Buffer.alloc(44 + numSamples * 2);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  // Soft chime envelope so HTML5 <audio> plays cleanly alongside Web Speech synthesis
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 2.2 * paceMultiplier) * 0.15;
    const wave =
      Math.sin(2 * Math.PI * freqHz * t) * 0.6 +
      Math.sin(2 * Math.PI * (freqHz * 1.5) * t) * 0.4;
    const sample = Math.max(-1, Math.min(1, wave * envelope));
    buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
  }

  return `data:audio/wav;base64,${buffer.toString('base64')}`;
}

export class VoicePersonaLibraryService {
  static getLibraryCatalog(): VoicePersonaCatalogItem[] {
    return V3C_VOICE_LIBRARY;
  }

  static normalizeConfig(agentVoice: string, rawSettings: any, tenantName = 'IGI Insurance'): AgentVoiceAssignmentConfig {
    const existing = rawSettings?.voiceAssignment || {};
    const fixedVoiceId = existing.fixedVoiceId || agentVoice || 'shimmer';
    const rotationPoolIds = Array.isArray(existing.rotationPoolIds) && existing.rotationPoolIds.length > 0
      ? existing.rotationPoolIds
      : [fixedVoiceId, 'echo', 'coral'];

    return {
      mode: existing.mode || 'FIXED',
      fixedVoiceId,
      rotationPoolIds,
      rotationCursor: typeof existing.rotationCursor === 'number' ? existing.rotationCursor : 0,
      channelMap: {
        web_voice: existing.channelMap?.web_voice || fixedVoiceId,
        outbound_campaign: existing.channelMap?.outbound_campaign || 'nova',
        whatsapp_voice: existing.channelMap?.whatsapp_voice || 'alloy',
      },
      timeWindowMap: {
        morningVoiceId: existing.timeWindowMap?.morningVoiceId || 'nova',
        afternoonEveningVoiceId: existing.timeWindowMap?.afternoonEveningVoiceId || 'shimmer',
        afterHoursVoiceId: existing.timeWindowMap?.afterHoursVoiceId || 'sage',
      },
      segmentMap: {
        premium: existing.segmentMap?.premium || 'onyx',
        standard: existing.segmentMap?.standard || 'alloy',
      },
      shortlistedVoiceIds: Array.isArray(existing.shortlistedVoiceIds)
        ? existing.shortlistedVoiceIds
        : [fixedVoiceId, 'coral'],
      customBrandName: existing.customBrandName || tenantName,
    };
  }

  static async getAgentVoiceLibraryState(tenantId: string, agentId: string) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      include: { Tenant: { select: { name: true } } },
    });

    if (!agent) {
      throw new AppError('Agent not found for this tenant', 404);
    }

    const assignment = this.normalizeConfig(
      agent.voice || 'shimmer',
      agent.voiceSettings,
      agent.Tenant?.name || 'IGI Insurance'
    );

    return {
      agentId: agent.id,
      agentName: agent.name,
      catalog: V3C_VOICE_LIBRARY,
      assignment,
    };
  }

  static async saveAgentVoiceAssignment(
    tenantId: string,
    agentId: string,
    input: Partial<AgentVoiceAssignmentConfig>
  ) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      include: { Tenant: { select: { name: true } } },
    });

    if (!agent) {
      throw new AppError('Agent not found for this tenant', 404);
    }

    const current = this.normalizeConfig(
      agent.voice || 'shimmer',
      agent.voiceSettings,
      agent.Tenant?.name || 'IGI Insurance'
    );

    const validIds = new Set(V3C_VOICE_LIBRARY.map((v) => v.id));
    const nextFixed = input.fixedVoiceId && validIds.has(input.fixedVoiceId)
      ? input.fixedVoiceId
      : current.fixedVoiceId;

    const nextPool = Array.isArray(input.rotationPoolIds)
      ? input.rotationPoolIds.filter((id) => validIds.has(id))
      : current.rotationPoolIds;

    if ((input.mode || current.mode) === 'ROTATION_POOL' && nextPool.length === 0) {
      throw new AppError('Rotation Pool requires at least 1 selected voice persona', 400);
    }

    const updatedAssignment: AgentVoiceAssignmentConfig = {
      mode: input.mode || current.mode,
      fixedVoiceId: nextFixed,
      rotationPoolIds: nextPool.length > 0 ? nextPool : [nextFixed],
      rotationCursor: typeof input.rotationCursor === 'number' ? input.rotationCursor : current.rotationCursor,
      channelMap: {
        web_voice: input.channelMap?.web_voice || current.channelMap.web_voice,
        outbound_campaign: input.channelMap?.outbound_campaign || current.channelMap.outbound_campaign,
        whatsapp_voice: input.channelMap?.whatsapp_voice || current.channelMap.whatsapp_voice,
      },
      timeWindowMap: {
        morningVoiceId: input.timeWindowMap?.morningVoiceId || current.timeWindowMap.morningVoiceId,
        afternoonEveningVoiceId:
          input.timeWindowMap?.afternoonEveningVoiceId || current.timeWindowMap.afternoonEveningVoiceId,
        afterHoursVoiceId: input.timeWindowMap?.afterHoursVoiceId || current.timeWindowMap.afterHoursVoiceId,
      },
      segmentMap: {
        premium: input.segmentMap?.premium || current.segmentMap.premium,
        standard: input.segmentMap?.standard || current.segmentMap.standard,
      },
      shortlistedVoiceIds: Array.isArray(input.shortlistedVoiceIds)
        ? input.shortlistedVoiceIds.filter((id) => validIds.has(id))
        : current.shortlistedVoiceIds,
      customBrandName: (input.customBrandName ?? current.customBrandName).trim() || 'IGI Insurance',
    };

    const resolvedPrimaryPersona =
      V3C_VOICE_LIBRARY.find((v) => v.id === updatedAssignment.fixedVoiceId) || V3C_VOICE_LIBRARY[0];

    const existingSettings = (agent.voiceSettings as Record<string, any>) || {};
    const nextVoiceSettings = {
      ...existingSettings,
      gender: resolvedPrimaryPersona.gender === 'female' ? 'female' : 'male',
      voiceAssignment: updatedAssignment,
    };

    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        voice: updatedAssignment.fixedVoiceId,
        voiceSettings: nextVoiceSettings as any,
        updatedAt: new Date(),
      },
    });

    TenantConfigCache.invalidate(tenantId);

    return updatedAssignment;
  }

  static async resolveSessionVoicePersona(
    tenantId: string,
    agentId: string,
    context: {
      channel?: 'web_voice' | 'outbound_campaign' | 'whatsapp_voice';
      hourOfDay?: number;
      customerSegment?: 'premium' | 'standard';
    } = {}
  ) {
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      include: { Tenant: { select: { name: true } } },
    });

    if (!agent) {
      throw new AppError('Agent not found for this tenant', 404);
    }

    const assignment = this.normalizeConfig(
      agent.voice || 'shimmer',
      agent.voiceSettings,
      agent.Tenant?.name || 'IGI Insurance'
    );

    let resolvedVoiceId = assignment.fixedVoiceId;
    let resolutionReason = 'Fixed default persona assigned to agent';

    if (assignment.mode === 'ROTATION_POOL') {
      const pool = assignment.rotationPoolIds.length > 0 ? assignment.rotationPoolIds : [assignment.fixedVoiceId];
      const index = assignment.rotationCursor % pool.length;
      resolvedVoiceId = pool[index];
      const nextCursor = (assignment.rotationCursor + 1) % pool.length;

      const existingSettings = (agent.voiceSettings as Record<string, any>) || {};
      await prisma.agent.update({
        where: { id: agent.id },
        data: {
          voiceSettings: {
            ...existingSettings,
            voiceAssignment: {
              ...assignment,
              rotationCursor: nextCursor,
            },
          } as any,
        },
      });

      resolutionReason = `Rotation Pool session slot #${index + 1} of ${pool.length} (next cursor -> ${nextCursor})`;
    } else if (assignment.mode === 'CHANNEL_SPECIFIC') {
      const ch = context.channel || 'web_voice';
      resolvedVoiceId = assignment.channelMap[ch] || assignment.fixedVoiceId;
      resolutionReason = `Channel-Specific mapping for channel '${ch}'`;
    } else if (assignment.mode === 'TIME_OF_DAY') {
      const hour = typeof context.hourOfDay === 'number' ? context.hourOfDay : new Date().getHours();
      if (hour >= 9 && hour < 13) {
        resolvedVoiceId = assignment.timeWindowMap.morningVoiceId;
        resolutionReason = `Time-of-Day morning window (09:00–13:00, hour=${hour})`;
      } else if (hour >= 13 && hour < 20) {
        resolvedVoiceId = assignment.timeWindowMap.afternoonEveningVoiceId;
        resolutionReason = `Time-of-Day afternoon/evening window (13:00–20:00, hour=${hour})`;
      } else {
        resolvedVoiceId = assignment.timeWindowMap.afterHoursVoiceId;
        resolutionReason = `Time-of-Day after-hours calm window (20:00–09:00, hour=${hour})`;
      }
    } else if (assignment.mode === 'CUSTOMER_SEGMENT') {
      const seg = context.customerSegment || 'standard';
      resolvedVoiceId = assignment.segmentMap[seg] || assignment.fixedVoiceId;
      resolutionReason = `Customer-Segment mapping for '${seg}' tier`;
    }

    const persona =
      V3C_VOICE_LIBRARY.find((v) => v.id === resolvedVoiceId) || V3C_VOICE_LIBRARY[0];

    return {
      mode: assignment.mode,
      resolvedVoiceId: persona.id,
      persona,
      resolutionReason,
      timestamp: new Date().toISOString(),
    };
  }

  static generateSamplePreview(params: {
    voiceId: string;
    language?: string;
    pace?: SpeakingPace;
    brandName?: string;
  }) {
    const persona =
      V3C_VOICE_LIBRARY.find((v) => v.id === params.voiceId) || V3C_VOICE_LIBRARY[0];
    const language = params.language || 'English';
    const pace: SpeakingPace = params.pace || 'normal';
    const brand = (params.brandName || 'IGI Insurance').trim();

    const paceMultiplier = pace === 'slow' ? 0.85 : pace === 'fast' ? 1.2 : 1.0;

    const scriptsByLang: Record<
      string,
      { greeting: string; questionHandling: string; closing: string }
    > = {
      English: {
        greeting: `Assalam-o-Alaikum and welcome to ${brand}. My name is ${persona.name.split(' ')[0]}, your virtual specialist.`,
        questionHandling: `I have verified your ${brand} policy record in real time and can confirm your renewal coverage is active with zero pending claims.`,
        closing: `Thank you for choosing ${brand}. Please let me know if I can assist you with anything else today.`,
      },
      Urdu: {
        greeting: `السلام علیکم اور ${brand} میں خوش آمدید۔ میں آپ کی ورچوئل اسسٹنٹ بول رہی ہوں۔`,
        questionHandling: `میں نے آپ کے ${brand} پالیسی ریکارڈ کی تصدیق کر لی ہے اور آپ کی تجدید مکمل طور پر فعال ہے۔`,
        closing: `${brand} کا انتخاب کرنے کا شکریہ۔ کیا میں آج آپ کی مزید کوئی مدد کر سکتی ہوں؟`,
      },
      Sindhi: {
        greeting: `اسلام عليڪم، ${brand} ۾ اوهان کي ڀليڪار. مان اوهان جي مدد لاءِ حاضر آهيان.`,
        questionHandling: `اسان اوهان جي ${brand} پاليسي تفصيل چيڪ ڪئي آهي ۽ اوهان جو رڪارڊ مڪمل طور تي فعال آهي.`,
        closing: `${brand} سان رابطو ڪرڻ لاءِ مهرباني. ڇا مان اوهان جي ٻي ڪا مدد ڪري سگهان ٿي؟`,
      },
      Punjabi: {
        greeting: `اسلام علیکم جی، ${brand} وچ تہاڈا خیر مقدم اے۔ میں تہاڈی سہولت لئی حاضر آں۔`,
        questionHandling: `میں تہاڈے ${brand} پالیسی کھاتے دی تصدیق کر لئی اے تے تہاڈی پالیسی بالکل فعال اے۔`,
        closing: `${brand} نال رابطہ کرن دا شکریہ۔ دسو میں تہاڈی ہور کیہڑی خدمت کر سکدی آں؟`,
      },
      Pashto: {
        greeting: `سلام علیکم، ${brand} ته ښه راغلاست. زه ستاسو د مرستې لپاره دلته یم.`,
        questionHandling: `ما ستاسو د ${brand} پالیسۍ ریکارډ وکتلو او ستاسو بیمه په بشپړ ډول فعاله ده.`,
        closing: `له ${brand} سره د اړیکې له امله مننه. ایا زه ستاسو بله کومه مرسته کولی شم؟`,
      },
      Arabic: {
        greeting: `السلام عليكم ومرحباً بكم في ${brand}. أنا المساعد الذكي الخاص بكم.`,
        questionHandling: `لقد تحققت من وثيقة التأمين الخاصة بكم لدى ${brand} ويمكنني تأكيد سريان التغطية بالكامل.`,
        closing: `شكراً لاختياركم ${brand}. هل يمكنني مساعدتكم في أي استفسار آخر اليوم؟`,
      },
    };

    const segments = scriptsByLang[language] || scriptsByLang.English;
    const fullScript = `${segments.greeting} ${segments.questionHandling} ${segments.closing}`;

    return {
      voiceId: persona.id,
      personaName: persona.name,
      category: persona.category,
      gender: persona.gender,
      language,
      pace,
      paceMultiplier,
      durationSeconds: 15,
      brandNameInjected: brand,
      segments: [
        { stage: '00s – 05s: Greeting', text: segments.greeting },
        { stage: '05s – 11s: Question Handling', text: segments.questionHandling },
        { stage: '11s – 15s: Closing', text: segments.closing },
      ],
      fullScript,
      audioPreviewDataUri: buildSilentOrToneWavDataUri(persona.pitchHz, 1.4, paceMultiplier),
    };
  }
}

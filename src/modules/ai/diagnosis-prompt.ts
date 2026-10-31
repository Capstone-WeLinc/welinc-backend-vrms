import { Type as GeminiType } from '@google/genai';
import { RepairPriority } from '@prisma/client';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { AiProviderError } from './ai-provider';

// Spec 0013, Diagnosis pipeline step 4

export type HistoryItem = {
  ticketId: string;
  repairNumber: string;
  status: string;
  closedAt: string | null;
  issues: string[];
};

export type SimilarCase = {
  issueId: string;
  ticketId: string;
  repairNumber: string;
  description: string;
  similarity: number;
};

export type DiagnosisInput = {
  symptom: string;
  issues: string[];
  vehiclePlate: string;
  vehicleModel: string;
  vehicleHistory: HistoryItem[];
};

export type DiagnosisResult = {
  summary: string;
  predictedCategory: string;
  predictedPriority: RepairPriority;
  estimatedHours: number;
  probableCauses: string[];
  recommendedParts: { partName: string; estCostPhp: number | null }[];
  safetyNote: string;
};

const PRIORITIES = Object.values(RepairPriority);

/** Written by hand in Gemini's own schema format; lengths are checked again below. */
export const DIAGNOSIS_SCHEMA = {
  type: GeminiType.OBJECT,
  properties: {
    summary: { type: GeminiType.STRING },
    predictedCategory: { type: GeminiType.STRING },
    predictedPriority: { type: GeminiType.STRING, enum: PRIORITIES },
    estimatedHours: { type: GeminiType.NUMBER },
    probableCauses: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
    },
    recommendedParts: {
      type: GeminiType.ARRAY,
      items: {
        type: GeminiType.OBJECT,
        properties: { partName: { type: GeminiType.STRING } },
        required: ['partName'],
      },
    },
    safetyNote: { type: GeminiType.STRING },
  },
  required: [
    'summary',
    'predictedCategory',
    'predictedPriority',
    'estimatedHours',
    'probableCauses',
    'recommendedParts',
    'safetyNote',
  ],
  propertyOrdering: [
    'summary',
    'predictedCategory',
    'predictedPriority',
    'estimatedHours',
    'probableCauses',
    'recommendedParts',
    'safetyNote',
  ],
};

export function buildPrompt(
  input: DiagnosisInput,
  similar: SimilarCase[],
  categories: string[],
): string {
  const lines = [
    'You are an expert truck repair diagnostic assistant for WeLinc VRMS (Vehicle Repair Management System).',
    '',
    'A mechanic has reported the following vehicle symptom:',
    `"${input.symptom}"`,
    '',
    `Vehicle: ${input.vehiclePlate} (${input.vehicleModel})`,
  ];
  if (input.issues.length > 0) {
    lines.push('', 'Reported issues:', ...input.issues.map((i) => `  - ${i}`));
  }
  if (input.vehicleHistory.length > 0) {
    lines.push('', "This vehicle's recent repairs:");
    for (const item of input.vehicleHistory) {
      lines.push(
        `  - ${item.repairNumber} (${item.status}): ${item.issues.join('; ') || 'no issues logged'}`,
      );
    }
  }
  if (similar.length > 0) {
    lines.push('', 'Similar past fleet repairs:');
    for (const c of similar) {
      lines.push(
        `  - (${Math.round(c.similarity * 100)}% similar) ${c.description}`,
      );
    }
  }
  lines.push(
    '',
    'Answer in JSON with these fields:',
    '- summary: a clear, specific 1 to 2 sentence diagnosis of the most likely root cause (at most 500 characters).',
    `- predictedCategory: one of ${categories.join(', ')}.`,
    `- predictedPriority: one of ${PRIORITIES.join(', ')}.`,
    '- estimatedHours: estimated repair time in hours, above 0 and at most 200.',
    '- probableCauses: 1 to 6 specific, technically accurate probable root causes.',
    '- recommendedParts: up to 8 parts, each with partName only.',
    '- safetyNote: a specific safety warning for this issue, or an empty string if it is safe to drive (at most 500 characters).',
    '',
    'Be specific to the symptom. Use the vehicle history and similar past repairs when they are relevant.',
  );
  return lines.join('\n');
}

class PartReply {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  partName!: string;
}

class DiagnosisReply {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @IsString()
  predictedCategory!: string;

  @IsIn(PRIORITIES)
  predictedPriority!: RepairPriority;

  @IsNumber()
  @Min(0.01)
  @Max(200)
  estimatedHours!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  probableCauses!: string[];

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => PartReply)
  recommendedParts!: PartReply[];

  @IsString()
  @MaxLength(500)
  safetyNote!: string;
}

/**
 * Checks the reply in code, since Gemini doesn't enforce lengths. A failed check is a provider
 * error (AI_UNAVAILABLE); an unknown category becomes General. Prices are filled in later.
 */
export function validateReply(
  raw: unknown,
  categories: string[],
): DiagnosisResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AiProviderError('The reply was not a JSON object');
  }
  const reply = plainToInstance(DiagnosisReply, raw);
  const errors = validateSync(reply);
  if (errors.length > 0) {
    throw new AiProviderError(
      `The reply failed validation: ${errors.map((e) => e.property).join(', ')}`,
    );
  }
  const category = categories.find(
    (c) => c.toLowerCase() === reply.predictedCategory.trim().toLowerCase(),
  );
  return {
    summary: reply.summary,
    predictedCategory: category ?? 'General',
    predictedPriority: reply.predictedPriority,
    estimatedHours: reply.estimatedHours,
    probableCauses: reply.probableCauses,
    recommendedParts: reply.recommendedParts.map((p) => ({
      partName: p.partName,
      estCostPhp: null,
    })),
    safetyNote: reply.safetyNote,
  };
}

/** Today's rule (AC-8 step 6): a live answer scores 3, then context adds points. */
export function confidenceOf(
  similar: SimilarCase[],
  historyCount: number,
): 'High' | 'Moderate' | 'Low' {
  let score = 3;
  if (similar.length >= 3) score += 2;
  else if (similar.length >= 1) score += 1;
  if (historyCount > 0) score += 1;
  if (similar.length > 0) {
    const avg =
      similar.reduce((sum, c) => sum + c.similarity, 0) / similar.length;
    if (avg >= 0.8) score += 2;
    else if (avg >= 0.65) score += 1;
  }
  if (score >= 6) return 'High';
  if (score >= 3) return 'Moderate';
  return 'Low';
}

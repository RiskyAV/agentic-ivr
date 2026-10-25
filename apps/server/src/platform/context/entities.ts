import type { Paise } from '@app/domain';

export interface EntityMemory {
  activeLoanId?: string;
  lastAmount?: Paise;
  lastTopic?: string;
}

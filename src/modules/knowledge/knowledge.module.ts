import { Module } from '@nestjs/common';
import SharedModule from '../../shared/shared.module';
import { KnowledgeCategoriesService } from './knowledge-categories.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import { KnowledgeEntryEditorService } from './knowledge-entry-editor.service';
import { KnowledgeSuggestionsService } from './knowledge-suggestions.service';

@Module({
  imports: [SharedModule],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeCategoriesService,
    KnowledgeEntriesService,
    KnowledgeEntryEditorService,
    KnowledgeSuggestionsService,
  ],
  exports: [KnowledgeEntriesService],
})
export class KnowledgeModule {}

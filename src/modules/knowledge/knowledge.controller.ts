import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { CurrentAbility } from '../../auth/permissions/current-ability.decorator';
import { RequirePermission } from '../../auth/permissions/permission.decorators';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { CreateEntryDto } from './dto/create-entry.dto';
import { UpdateEntryDto } from './dto/entry-fields.dto';
import { FindEntriesQueryDto } from './dto/find-entries-query.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { UpdateEntryStatusDto } from './dto/update-entry-status.dto';
import {
  CreateSuggestionDto,
  DismissGroupDto,
  ResolveSuggestionDto,
} from './dto/suggestion.dto';
import { JwtUser } from './knowledge-actor';
import { KnowledgeCategoriesService } from './knowledge-categories.service';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import { KnowledgeEntryEditorService } from './knowledge-entry-editor.service';
import { KnowledgeSuggestionsService } from './knowledge-suggestions.service';

type AuthRequest = { user: JwtUser };

// Spec 0007, API surface, on the spec 0011 keys: reads need knowledge.view, writes knowledge.edit.
@Controller('vrms/knowledge')
export class KnowledgeController {
  constructor(
    private readonly categories: KnowledgeCategoriesService,
    private readonly entries: KnowledgeEntriesService,
    private readonly editor: KnowledgeEntryEditorService,
    private readonly suggestions: KnowledgeSuggestionsService,
  ) {}

  // ── Categories ──────────────────────────────────────────────────────────

  @RequirePermission('knowledge.view')
  @Get('categories')
  listCategories(
    @Query() query: ListCategoriesQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.categories.list(query, ability);
  }

  @RequirePermission('knowledge.edit')
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto, @Req() req: AuthRequest) {
    return this.categories.create(dto, req.user);
  }

  @RequirePermission('knowledge.edit')
  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.categories.update(id, dto, req.user);
  }

  // ── Entries ─────────────────────────────────────────────────────────────

  @RequirePermission('knowledge.view')
  @Get('entries')
  listEntries(
    @Query() query: FindEntriesQueryDto,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.entries.list(query, ability);
  }

  @RequirePermission('knowledge.edit')
  @Post('entries')
  createEntry(
    @Body() dto: CreateEntryDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editor.create(dto, req.user, ability);
  }

  // Before entries/:id, so "options" never reaches the UUID pipe
  @RequirePermission('knowledge.view')
  @Get('entries/options')
  entryOptions(@CurrentAbility() ability: AppAbility) {
    return this.entries.options(ability);
  }

  @RequirePermission('knowledge.view')
  @Get('entries/:id')
  findEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.entries.findOne(id, ability);
  }

  @RequirePermission('knowledge.edit')
  @Patch('entries/:id')
  updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editor.update(id, dto, req.user, ability);
  }

  @RequirePermission('knowledge.edit')
  @Patch('entries/:id/status')
  setEntryStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryStatusDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.editor.setStatus(id, dto, req.user, ability);
  }

  @RequirePermission('knowledge.edit')
  @Get('entries/:id/changes')
  entryChanges(@Param('id', ParseUUIDPipe) id: string) {
    return this.editor.changes(id);
  }

  // ── Suggestions (AC-32 to AC-36) ────────────────────────────────────────

  @RequirePermission('knowledge.edit')
  @Get('suggestions')
  listSuggestions() {
    return this.suggestions.list();
  }

  // Before suggestions/:id
  @RequirePermission('knowledge.edit')
  @Get('suggestions/count')
  suggestionCount() {
    return this.suggestions.count();
  }

  @RequirePermission('knowledge.edit')
  @Post('suggestions/dismiss-group')
  dismissGroup(@Body() dto: DismissGroupDto) {
    return this.suggestions.dismissGroup(dto);
  }

  @RequirePermission('knowledge.suggest')
  @Post('suggestions')
  createSuggestion(
    @Body() dto: CreateSuggestionDto,
    @Req() req: AuthRequest,
    @CurrentAbility() ability: AppAbility,
  ) {
    return this.suggestions.create(dto, req.user, ability);
  }

  @RequirePermission('knowledge.edit')
  @Patch('suggestions/:id')
  resolveSuggestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSuggestionDto,
    @Req() req: AuthRequest,
  ) {
    return this.suggestions.resolve(id, dto, req.user);
  }
}

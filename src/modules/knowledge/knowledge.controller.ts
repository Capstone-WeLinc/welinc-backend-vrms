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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
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
import {
  JwtUser,
  KNOWLEDGE_EDITORS,
  KNOWLEDGE_READERS,
} from './knowledge-actor';
import { KnowledgeCategoriesService } from './knowledge-categories.service';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import { KnowledgeEntryEditorService } from './knowledge-entry-editor.service';
import { KnowledgeSuggestionsService } from './knowledge-suggestions.service';

type AuthRequest = { user: JwtUser };

// Spec 0007, API surface. Readers = ADMIN, CHIEF_MECHANIC, MECHANIC; Editors = ADMIN, CHIEF_MECHANIC.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vrms/knowledge')
export class KnowledgeController {
  constructor(
    private readonly categories: KnowledgeCategoriesService,
    private readonly entries: KnowledgeEntriesService,
    private readonly editor: KnowledgeEntryEditorService,
    private readonly suggestions: KnowledgeSuggestionsService,
  ) {}

  // ── Categories ──────────────────────────────────────────────────────────

  @Roles(...KNOWLEDGE_READERS)
  @Get('categories')
  listCategories(
    @Query() query: ListCategoriesQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.categories.list(query, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto, @Req() req: AuthRequest) {
    return this.categories.create(dto, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Patch('categories/:id')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.categories.update(id, dto, req.user);
  }

  // ── Entries ─────────────────────────────────────────────────────────────

  @Roles(...KNOWLEDGE_READERS)
  @Get('entries')
  listEntries(@Query() query: FindEntriesQueryDto, @Req() req: AuthRequest) {
    return this.entries.list(query, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Post('entries')
  createEntry(@Body() dto: CreateEntryDto, @Req() req: AuthRequest) {
    return this.editor.create(dto, req.user);
  }

  // Before entries/:id, so "options" never reaches the UUID pipe
  @Roles(...KNOWLEDGE_READERS)
  @Get('entries/options')
  entryOptions(@Req() req: AuthRequest) {
    return this.entries.options(req.user);
  }

  @Roles(...KNOWLEDGE_READERS)
  @Get('entries/:id')
  findEntry(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.entries.findOne(id, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Patch('entries/:id')
  updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryDto,
    @Req() req: AuthRequest,
  ) {
    return this.editor.update(id, dto, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Patch('entries/:id/status')
  setEntryStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.editor.setStatus(id, dto, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Get('entries/:id/changes')
  entryChanges(@Param('id', ParseUUIDPipe) id: string) {
    return this.editor.changes(id);
  }

  // ── Suggestions (AC-32 to AC-36) ────────────────────────────────────────

  @Roles(...KNOWLEDGE_EDITORS)
  @Get('suggestions')
  listSuggestions() {
    return this.suggestions.list();
  }

  // Before suggestions/:id
  @Roles(...KNOWLEDGE_EDITORS)
  @Get('suggestions/count')
  suggestionCount() {
    return this.suggestions.count();
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Post('suggestions/dismiss-group')
  dismissGroup(@Body() dto: DismissGroupDto) {
    return this.suggestions.dismissGroup(dto);
  }

  @Roles(...KNOWLEDGE_READERS)
  @Post('suggestions')
  createSuggestion(@Body() dto: CreateSuggestionDto, @Req() req: AuthRequest) {
    return this.suggestions.create(dto, req.user);
  }

  @Roles(...KNOWLEDGE_EDITORS)
  @Patch('suggestions/:id')
  resolveSuggestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSuggestionDto,
    @Req() req: AuthRequest,
  ) {
    return this.suggestions.resolve(id, dto, req.user);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard, Roles, RolesGuard } from '../identity/index.js';
import { catalogInvalidQueryException } from './catalog.errors.js';
import { CatalogService } from './catalog.service.js';
import type {
  AdminCatalogProductDto,
  AdminProductListResponse,
  CreateProductInput,
  ProductImageDto,
  ProductImageInput,
  ProductTranslationDto,
  UpdateProductInput,
  UpsertTranslationInput,
} from './catalog.types.js';

@Controller('admin/products')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class CatalogAdminController {
  constructor(private readonly catalogService: CatalogService) {}

  @Post()
  @Idempotent()
  async create(@Body() body: CreateProductInput): Promise<AdminCatalogProductDto> {
    return this.catalogService.createProduct(body);
  }

  @Patch(':id')
  @Idempotent()
  async update(
    @Param('id') id: string,
    @Body() body: UpdateProductInput,
  ): Promise<AdminCatalogProductDto> {
    return this.catalogService.updateProduct(id, body);
  }

  @Put(':id/translations/:locale')
  @Idempotent()
  async upsertTranslation(
    @Param('id') id: string,
    @Param('locale') locale: string,
    @Body() body: UpsertTranslationInput,
  ): Promise<ProductTranslationDto> {
    return this.catalogService.upsertTranslation(id, locale, body);
  }

  @Put(':id/images')
  @Idempotent()
  async setImages(
    @Param('id') id: string,
    @Body() body: { images: ProductImageInput[] },
  ): Promise<{ images: ProductImageDto[] }> {
    const images = await this.catalogService.setProductImages(id, body?.images);
    return { images };
  }

  @Post(':id/publish')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async publish(@Param('id') id: string): Promise<AdminCatalogProductDto> {
    return this.catalogService.publishProduct(id);
  }

  @Post(':id/archive')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async archive(@Param('id') id: string): Promise<AdminCatalogProductDto> {
    return this.catalogService.archiveProduct(id);
  }

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('supplierId') supplierId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<AdminProductListResponse> {
    let limit: number | undefined;
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        throw catalogInvalidQueryException('limit must be an integer between 1 and 50');
      }
      limit = parsed;
    }

    return this.catalogService.listAdminProducts({
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(supplierId ? { supplierId } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<AdminCatalogProductDto> {
    return this.catalogService.getAdminProductById(id);
  }
}

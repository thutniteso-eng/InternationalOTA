import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CatalogService } from './catalog.service.js';
import type { PublicCatalogListResponse, PublicCatalogProductDetail } from './catalog.types.js';

@Controller('catalog/products')
export class CatalogPublicController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('locale') locale?: string,
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('near') near?: string,
    @Query('radiusKm') radiusKm?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PublicCatalogListResponse> {
    const acceptLanguage = req.headers['accept-language'];
    const result = await this.catalogService.listPublishedProducts({
      ...(locale !== undefined ? { locale } : {}),
      ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(near !== undefined ? { near } : {}),
      ...(radiusKm !== undefined ? { radiusKm } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    res.setHeader('Content-Language', result.locale);
    return result.data;
  }

  @Get(':locale/:slug')
  async getBySlug(
    @Param('locale') locale: string,
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicCatalogProductDetail> {
    const product = await this.catalogService.getPublishedProductBySlug(locale, slug);
    res.setHeader('Content-Language', product.locale);
    return product;
  }
}

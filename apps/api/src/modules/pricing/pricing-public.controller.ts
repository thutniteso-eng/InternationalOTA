import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PricingService } from './pricing.service.js';
import type { PublicQuoteResponse } from './pricing.types.js';

@Controller('catalog/products')
export class PricingPublicController {
  constructor(private readonly pricingService: PricingService) {}

  @Get(':productId/quote')
  async getQuote(
    @Param('productId') productId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('departureId') departureId?: string,
    @Query('adult') adult?: string,
    @Query('child') child?: string,
    @Query('infant') infant?: string,
    @Query('locale') locale?: string,
  ): Promise<PublicQuoteResponse> {
    const acceptLanguage = req.headers['accept-language'];
    const result = await this.pricingService.getPublicQuote(productId, {
      ...(departureId !== undefined ? { departureId } : {}),
      ...(adult !== undefined ? { adult } : {}),
      ...(child !== undefined ? { child } : {}),
      ...(infant !== undefined ? { infant } : {}),
      ...(locale !== undefined ? { locale } : {}),
      ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
    });

    res.setHeader('Content-Language', result.locale);
    return result.data;
  }
}

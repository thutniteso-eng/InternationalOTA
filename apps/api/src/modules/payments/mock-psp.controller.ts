import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { mockTransactionNotFoundException } from './payments.errors.js';
import type { MockPspAction } from './payments.types.js';

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'success',
  'fail',
  'cancel',
  'duplicate',
  'delayed_3m',
  'wrong_amount',
]);

function resolveInternalCallbackUrl(req: Request): string {
  const configured = process.env['MOCK_PSP_CALLBACK_URL']?.trim();
  if (configured) {
    return configured;
  }
  const localPort = req.socket?.localPort ?? Number(process.env['API_PORT'] ?? 4000);
  return `http://127.0.0.1:${localPort}/webhooks/mock-psp`;
}

@Controller('mock-psp')
export class MockPspController {
  constructor(private readonly mockProvider: MockPaymentProvider) {}

  @Get('checkout/:providerRef')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async getCheckoutPage(
    @Param('providerRef') providerRef: string,
    @Req() req: Request,
  ): Promise<string> {
    if (!this.mockProvider.isAvailable()) {
      throw mockTransactionNotFoundException();
    }
    const txRow = await this.mockProvider.getTransactionForHostedPage(providerRef);
    const rawAcceptLang = req.headers['accept-language'] as string | string[] | undefined;
    const acceptLang = Array.isArray(rawAcceptLang) ? rawAcceptLang[0] : rawAcceptLang;
    return this.mockProvider.renderCheckoutHtml(txRow, acceptLang);
  }

  @Post('checkout/:providerRef/action')
  @HttpCode(HttpStatus.SEE_OTHER)
  async submitCheckoutAction(
    @Param('providerRef') providerRef: string,
    @Body() body: { action?: string } | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.mockProvider.isAvailable()) {
      throw mockTransactionNotFoundException();
    }
    const actionRaw = typeof body?.action === 'string' ? body.action.trim() : '';
    if (!VALID_ACTIONS.has(actionRaw)) {
      throw mockTransactionNotFoundException();
    }

    const callbackUrl = resolveInternalCallbackUrl(req);
    const { redirectUrl } = await this.mockProvider.executeCheckoutAction(
      providerRef,
      actionRaw as MockPspAction,
      callbackUrl,
    );
    res.redirect(HttpStatus.SEE_OTHER, redirectUrl);
  }
}

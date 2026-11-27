import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard, CurrentPrincipal, type Principal } from '../identity/index.js';
import { PaymentsService } from './payments.service.js';
import type {
  BookingCancellationPreviewDto,
  InitiateCheckoutRequestDto,
  InitiateCheckoutResponseDto,
} from './payments.types.js';
import { RefundService } from './refund.service.js';

@Controller()
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly refundService: RefundService,
  ) {}

  @Get('bookings/:reference/cancellation-preview')
  async getCancellationPreview(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
  ): Promise<BookingCancellationPreviewDto> {
    return this.refundService.previewCancellation(reference, principal.userId);
  }

  @Post('bookings/:reference/checkout')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async initiateCheckout(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
    @Body() body?: InitiateCheckoutRequestDto,
  ): Promise<InitiateCheckoutResponseDto> {
    return this.paymentsService.initiateCheckout(reference, principal.userId, body);
  }
}

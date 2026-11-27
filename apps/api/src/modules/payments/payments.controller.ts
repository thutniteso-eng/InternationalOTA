import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard, CurrentPrincipal, type Principal } from '../identity/index.js';
import { PaymentsService } from './payments.service.js';
import type { InitiateCheckoutRequestDto, InitiateCheckoutResponseDto } from './payments.types.js';

@Controller()
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

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

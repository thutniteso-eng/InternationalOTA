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
import {
  AuthGuard,
  CurrentPrincipal,
  type Principal,
  Roles,
  RolesGuard,
} from '../identity/index.js';
import type {
  AdminRefundDto,
  DepartureCancellationSummaryDto,
  DepartureCancelRequestDto,
  DepartureCancelResultDto,
} from './payments.types.js';
import { RefundService } from './refund.service.js';

@Controller('admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('admin', 'operator')
export class RefundAdminController {
  constructor(private readonly refundService: RefundService) {}

  @Post('departures/:id/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async cancelDeparture(
    @CurrentPrincipal() principal: Principal,
    @Param('id') departureId: string,
    @Body() body?: DepartureCancelRequestDto,
  ): Promise<DepartureCancelResultDto> {
    return this.refundService.cancelDeparture(departureId, principal.userId, body?.reason);
  }

  @Get('departures/:id/cancellation-summary')
  async getDepartureCancellationSummary(
    @Param('id') departureId: string,
  ): Promise<DepartureCancellationSummaryDto> {
    return this.refundService.getDepartureCancellationSummary(departureId);
  }

  @Post('refunds/:id/retry')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async retryRefund(
    @CurrentPrincipal() principal: Principal,
    @Param('id') refundId: string,
  ): Promise<AdminRefundDto> {
    return this.refundService.adminRetryRefund(refundId, principal.userId);
  }
}

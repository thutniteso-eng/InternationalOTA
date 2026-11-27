import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Idempotent } from '../idempotency/index.js';
import { AuthGuard, CurrentPrincipal, type Principal } from '../identity/index.js';
import { BookingService } from './booking.service.js';
import type {
  BookingContactInput,
  BookingDetailDto,
  ConfirmedCancelResponseDto,
  CustomerBookingListResponse,
  HoldBookingResponseDto,
} from './booking.types.js';

interface CreateHoldRequestBody {
  departureId: string;
  pax: { adult: number; child?: number; infant?: number };
  contact: BookingContactInput;
  expectedSnapshotHash: string;
}

@Controller()
@UseGuards(AuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post('bookings')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  async createHold(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateHoldRequestBody,
    @Req() req: Request,
  ): Promise<HoldBookingResponseDto> {
    const acceptLanguage = req.headers['accept-language'];
    return this.bookingService.createHoldHttp({
      customerUserId: principal.userId,
      departureId: body?.departureId,
      pax: {
        adult: body?.pax?.adult,
        child: body?.pax?.child ?? 0,
        infant: body?.pax?.infant ?? 0,
      },
      contact: body?.contact,
      expectedSnapshotHash: body?.expectedSnapshotHash,
      ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
    });
  }

  @Get('me/bookings')
  async listMyBookings(
    @CurrentPrincipal() principal: Principal,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CustomerBookingListResponse> {
    return this.bookingService.listBookingsForCustomer(principal.userId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Get('bookings/:reference')
  async getByReference(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
  ): Promise<BookingDetailDto> {
    return this.bookingService.getBookingForCustomerByReference(reference, principal.userId);
  }

  @Post('bookings/:reference/cancel')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async cancelBooking(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
  ): Promise<BookingDetailDto | ConfirmedCancelResponseDto> {
    return this.bookingService.cancelByReferenceHttp(reference, principal.userId);
  }

  /**
   * Temporary endpoint until P2-06 payment initiation, exercising D-018 (`emailVerified`) and `held -> payment_pending`.
   */
  @Post('bookings/:reference/payment-pending')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async markPaymentPending(
    @CurrentPrincipal() principal: Principal,
    @Param('reference') reference: string,
  ): Promise<BookingDetailDto> {
    return this.bookingService.markPaymentPendingByReferenceHttp(reference, principal.userId);
  }
}

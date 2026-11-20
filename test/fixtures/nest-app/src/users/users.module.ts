import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { UnusedService } from './unused.service';
import { ExportedOnlyService } from './exported-only.service';
import { ReferencedService } from './referenced.service';
import { CleanupService } from './cleanup.service';
import { SmtpMailer } from './smtp.mailer';
import { FactoryDepService } from './factory-dep.service';
import { Cache } from './cache';
import { RedisCache } from './redis.cache';

@Module({
  providers: [
    UsersService, UsersRepository, UnusedService, ExportedOnlyService, ReferencedService, CleanupService,
    { provide: 'MAILER', useClass: SmtpMailer },
    FactoryDepService,
    { provide: Cache, useClass: RedisCache },
    { provide: 'CFG', useFactory: (d: FactoryDepService) => d, inject: [FactoryDepService] },
  ],
  controllers: [UsersController],
  exports: [UsersService, ExportedOnlyService],
})
export class UsersModule {}

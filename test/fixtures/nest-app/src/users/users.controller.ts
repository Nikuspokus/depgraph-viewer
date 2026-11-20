import { Controller, Inject } from '@nestjs/common';
import { UsersService } from './users.service';
import { Cache } from './cache';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService, @Inject('MAILER') private readonly mailer: unknown, private readonly cache: Cache) {}
}

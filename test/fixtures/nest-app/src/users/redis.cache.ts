import { Injectable } from '@nestjs/common';
import { Cache } from './cache';
@Injectable()
export class RedisCache extends Cache {}

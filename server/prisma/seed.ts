import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const restaurants = [
  { id: 1,  name: 'Twinte',        cuisineType: 'Chinese',       googleRating: 3, hours: '6:26 AM',  priceLevel: 2, phone: '224-235-0414', website: 'pen.io',                takeout: false, delivery: false, yelpUrl: 'behance.net' },
  { id: 2,  name: 'Shufflester',   cuisineType: 'Japanese',      googleRating: 5, hours: '2:52 PM',  priceLevel: 2, phone: '576-297-3199', website: 'nih.gov',               takeout: false, delivery: true,  yelpUrl: 'gov.uk' },
  { id: 3,  name: 'Gabcube',       cuisineType: 'Mexican',       googleRating: 5, hours: '4:05 PM',  priceLevel: 1, phone: '794-564-9564', website: 'mail.ru',               takeout: true,  delivery: true,  yelpUrl: 'webs.com' },
  { id: 4,  name: 'Eamia',         cuisineType: 'Mexican',       googleRating: 1, hours: '3:38 PM',  priceLevel: 1, phone: '237-736-4650', website: 'delicious.com',         takeout: false, delivery: true,  yelpUrl: 'gravatar.com' },
  { id: 5,  name: 'Livefish',      cuisineType: 'Indian',        googleRating: 4, hours: '10:51 AM', priceLevel: 2, phone: '433-219-4245', website: 'booking.com',           takeout: false, delivery: false, yelpUrl: 'youtu.be' },
  { id: 6,  name: 'Shuffletag',    cuisineType: 'French',        googleRating: 1, hours: '11:57 PM', priceLevel: 1, phone: '314-765-2719', website: 'reddit.com',            takeout: true,  delivery: true,  yelpUrl: 'list-manage.com' },
  { id: 7,  name: 'Abata',         cuisineType: 'French',        googleRating: 3, hours: '1:32 PM',  priceLevel: 3, phone: '503-574-4038', website: 'yellowpages.com',       takeout: false, delivery: true,  yelpUrl: 't-online.de' },
  { id: 8,  name: 'Quatz',         cuisineType: 'French',        googleRating: 4, hours: '8:23 AM',  priceLevel: 3, phone: '659-578-3163', website: 'about.me',              takeout: true,  delivery: false, yelpUrl: 'tiny.cc' },
  { id: 9,  name: 'Devcast',       cuisineType: 'Thai',          googleRating: 2, hours: '7:03 PM',  priceLevel: 2, phone: '502-570-6092', website: 'zdnet.com',             takeout: true,  delivery: false, yelpUrl: 'jimdo.com' },
  { id: 10, name: 'Teklist',       cuisineType: 'Thai',          googleRating: 5, hours: '7:14 PM',  priceLevel: 4, phone: '436-752-1069', website: 'house.gov',             takeout: true,  delivery: false, yelpUrl: 'google.pl' },
  { id: 11, name: 'Geba',          cuisineType: 'Mediterranean', googleRating: 3, hours: '5:36 PM',  priceLevel: 1, phone: '673-883-0559', website: 'yellowbook.com',        takeout: false, delivery: true,  yelpUrl: 'blogger.com' },
  { id: 12, name: 'Edgeclub',      cuisineType: 'Greek',         googleRating: 2, hours: '2:08 AM',  priceLevel: 1, phone: '213-179-6221', website: 'dropbox.com',           takeout: false, delivery: false, yelpUrl: 'fema.gov' },
  { id: 13, name: 'Zoovu',         cuisineType: 'American',      googleRating: 4, hours: '7:03 PM',  priceLevel: 4, phone: '515-594-6308', website: 'pagesperso-orange.fr',  takeout: false, delivery: true,  yelpUrl: '163.com' },
  { id: 14, name: 'Gigabox',       cuisineType: 'Mediterranean', googleRating: 4, hours: '2:49 AM',  priceLevel: 4, phone: '761-350-8805', website: 'baidu.com',             takeout: false, delivery: false, yelpUrl: 'hatena.ne.jp' },
  { id: 15, name: 'Meemm',         cuisineType: 'Greek',         googleRating: 1, hours: '4:13 PM',  priceLevel: 2, phone: '165-287-0920', website: 'theguardian.com',       takeout: false, delivery: true,  yelpUrl: 'yellowpages.com' },
  { id: 16, name: 'Yozio',         cuisineType: 'Italian',       googleRating: 2, hours: '8:27 PM',  priceLevel: 2, phone: '640-471-5057', website: 'bizjournals.com',       takeout: true,  delivery: false, yelpUrl: 'usnews.com' },
  { id: 17, name: 'Quimm',         cuisineType: 'Japanese',      googleRating: 3, hours: '10:40 AM', priceLevel: 4, phone: '642-679-6418', website: 'mail.ru',               takeout: true,  delivery: false, yelpUrl: 'harvard.edu' },
  { id: 18, name: 'Livetube',      cuisineType: 'French',        googleRating: 2, hours: '2:36 AM',  priceLevel: 4, phone: '183-187-1118', website: 'disqus.com',            takeout: true,  delivery: false, yelpUrl: 'macromedia.com' },
  { id: 19, name: 'Feedfire',      cuisineType: 'Italian',       googleRating: 5, hours: '7:42 AM',  priceLevel: 1, phone: '990-617-7903', website: 'nytimes.com',           takeout: false, delivery: true,  yelpUrl: 'acquirethisname.com' },
  { id: 20, name: 'Topicware',     cuisineType: 'Greek',         googleRating: 5, hours: '2:48 AM',  priceLevel: 3, phone: '137-864-6618', website: 'de.vu',                 takeout: true,  delivery: true,  yelpUrl: 'posterous.com' },
  { id: 21, name: 'Reallinks',     cuisineType: 'Italian',       googleRating: 4, hours: '8:25 AM',  priceLevel: 3, phone: '459-247-1127', website: 'google.ca',             takeout: true,  delivery: true,  yelpUrl: 'theglobeandmail.com' },
  { id: 22, name: 'Linkbridge',    cuisineType: 'Indian',        googleRating: 4, hours: '7:32 AM',  priceLevel: 4, phone: '428-833-3575', website: 'about.me',              takeout: true,  delivery: true,  yelpUrl: 'goodreads.com' },
  { id: 23, name: 'Eabox',         cuisineType: 'Chinese',       googleRating: 5, hours: '5:24 PM',  priceLevel: 3, phone: '203-133-3357', website: 'moonfruit.com',         takeout: true,  delivery: true,  yelpUrl: 'reuters.com' },
  { id: 24, name: 'Npath',         cuisineType: 'Chinese',       googleRating: 5, hours: '7:08 AM',  priceLevel: 1, phone: '948-656-7280', website: 'ask.com',               takeout: true,  delivery: false, yelpUrl: 'sina.com.cn' },
  { id: 25, name: 'Blogtags',      cuisineType: 'American',      googleRating: 4, hours: '12:47 PM', priceLevel: 4, phone: '244-729-2159', website: 'indiegogo.com',         takeout: false, delivery: false, yelpUrl: 'privacy.gov.au' },
  { id: 26, name: 'Photolist',     cuisineType: 'Indian',        googleRating: 5, hours: '12:42 AM', priceLevel: 1, phone: '364-503-7441', website: 'mapy.cz',               takeout: true,  delivery: true,  yelpUrl: 'ft.com' },
  { id: 27, name: 'Realmix',       cuisineType: 'American',      googleRating: 2, hours: '5:36 AM',  priceLevel: 1, phone: '181-512-0836', website: 'studiopress.com',       takeout: false, delivery: true,  yelpUrl: 'nature.com' },
  { id: 28, name: 'Quire',         cuisineType: 'Chinese',       googleRating: 2, hours: '8:43 PM',  priceLevel: 1, phone: '509-113-6932', website: 'cdc.gov',               takeout: false, delivery: false, yelpUrl: 'topsy.com' },
  { id: 29, name: 'Yodoo',         cuisineType: 'Italian',       googleRating: 1, hours: '9:58 PM',  priceLevel: 2, phone: '967-772-5148', website: 'google.com.hk',         takeout: false, delivery: true,  yelpUrl: 'ft.com' },
  { id: 30, name: 'Wikibox',       cuisineType: 'Japanese',      googleRating: 4, hours: '5:19 AM',  priceLevel: 2, phone: '528-862-9198', website: 'acquirethisname.com',   takeout: true,  delivery: true,  yelpUrl: 'slate.com' },
  { id: 31, name: 'Jabbersphere',  cuisineType: 'Mediterranean', googleRating: 4, hours: '3:37 AM',  priceLevel: 2, phone: '153-661-1839', website: 'list-manage.com',       takeout: true,  delivery: true,  yelpUrl: 'seattletimes.com' },
  { id: 32, name: 'Thoughtbridge', cuisineType: 'Mediterranean', googleRating: 2, hours: '5:54 AM',  priceLevel: 1, phone: '842-985-4022', website: 'imdb.com',              takeout: false, delivery: true,  yelpUrl: 'lycos.com' },
  { id: 33, name: 'Browsecat',     cuisineType: 'Mexican',       googleRating: 3, hours: '8:42 PM',  priceLevel: 4, phone: '613-586-0748', website: 'youtube.com',           takeout: false, delivery: true,  yelpUrl: 'usnews.com' },
  { id: 34, name: 'Tazz',          cuisineType: 'Chinese',       googleRating: 2, hours: '7:57 AM',  priceLevel: 4, phone: '336-867-0491', website: '1688.com',              takeout: true,  delivery: false, yelpUrl: 'newyorker.com' },
  { id: 35, name: 'Jayo',          cuisineType: 'Japanese',      googleRating: 1, hours: '2:49 PM',  priceLevel: 2, phone: '873-680-4993', website: 'cdbaby.com',            takeout: true,  delivery: false, yelpUrl: 'cafepress.com' },
  { id: 36, name: 'Chatterpoint',  cuisineType: 'Indian',        googleRating: 3, hours: '5:14 AM',  priceLevel: 2, phone: '209-316-4600', website: 'mac.com',               takeout: false, delivery: false, yelpUrl: 'parallels.com' },
  { id: 37, name: 'Feedmix',       cuisineType: 'Indian',        googleRating: 3, hours: '10:41 PM', priceLevel: 4, phone: '258-227-5451', website: 'wikispaces.com',        takeout: true,  delivery: false, yelpUrl: 'thetimes.co.uk' },
  { id: 38, name: 'Tanoodle',      cuisineType: 'Italian',       googleRating: 4, hours: '8:23 AM',  priceLevel: 1, phone: '583-503-6085', website: 'geocities.jp',          takeout: false, delivery: true,  yelpUrl: 'ucla.edu' },
  { id: 39, name: 'Ntags',         cuisineType: 'French',        googleRating: 3, hours: '11:03 AM', priceLevel: 4, phone: '743-371-7765', website: 'joomla.org',            takeout: false, delivery: true,  yelpUrl: 'spiegel.de' },
  { id: 40, name: 'Rhynyx',        cuisineType: 'Japanese',      googleRating: 1, hours: '5:24 AM',  priceLevel: 4, phone: '589-204-2635', website: 'skype.com',             takeout: true,  delivery: true,  yelpUrl: 'mit.edu' },
];

async function main() {
  console.log('Seeding restaurants…');
  await prisma.restaurant.createMany({ data: restaurants, skipDuplicates: true });
  // Reset auto-increment sequence so new IDs start after 40
  await prisma.$executeRaw`SELECT setval('restaurants_id_seq', (SELECT MAX(id) FROM restaurants))`;
  console.log(`Seeded ${restaurants.length} restaurants.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => { console.error(err); prisma.$disconnect(); process.exit(1); });

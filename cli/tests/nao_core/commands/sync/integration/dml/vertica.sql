CREATE SCHEMA {schema};

CREATE TABLE {schema}.users (
id INTEGER NOT NULL,
name VARCHAR(255) NOT NULL,
email VARCHAR(255),
active BOOLEAN DEFAULT TRUE
);

INSERT INTO {schema}.users VALUES (1, 'Alice', 'alice@example.com', true);
INSERT INTO {schema}.users VALUES (2, 'Bob', NULL, false);
INSERT INTO {schema}.users VALUES (3, 'Charlie', 'charlie@example.com', true);

COMMENT ON TABLE {schema}.users IS 'Registered user accounts';
COMMENT ON COLUMN {schema}.users.email IS 'User email address';

CREATE TABLE {schema}.orders (
id INTEGER NOT NULL,
user_id INTEGER NOT NULL,
amount DOUBLE PRECISION NOT NULL
);

INSERT INTO {schema}.orders VALUES (1, 1, 99.99);
INSERT INTO {schema}.orders VALUES (2, 1, 24.50);

CREATE SCHEMA {another_schema};

CREATE TABLE {another_schema}.whatever (
id INTEGER NOT NULL,
price DOUBLE PRECISION NOT NULL
);

INSERT INTO {another_schema}.whatever VALUES (1, 5.25);

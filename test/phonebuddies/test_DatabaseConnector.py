import logging
import unittest
from unittest.mock import patch, MagicMock

from phonebuddies.DatabaseConnector import DatabaseConnector
from phonebuddies.Buddy import Buddy
from phonebuddies.EmailInfo import EmailInfo

class TestDatabaseConnector(unittest.TestCase):


    def setUp(self):
        """
        Set up some defaults to be returned by the mocked out _get_cells
        """
        self.mock_buddy_data = [
            [ "email1@gmail.com", "Pseudonym1", "Phone1", "City1", "Timezone1", "User Message1", "Full Name1", "English", "Yes"],
            [ "email2@gmail.com", "Pseudonym2", "Phone2", "City2", "Timezone2", "User Message2", "Full Name2", "Afghan", "Yes"],
            [ "email3@gmail.com", "Pseudonym3", "Phone3", "City3", "Timezone3", "User Message3", "Full Name3", "Afghan"],
        ]

        self.mock_match_data = [
            [ "email1@gmail.com", "email2@gmail.com" ],
            [ "email1@gmail.com", "email3@gmail.com" ],
        ]

        # Hide warning logs when running these tests
        logging.getLogger().setLevel(logging.ERROR)


    def _mocked_get_cells(self, cells_description):
        if "Matched" in cells_description:
            return self.mock_match_data
        elif "Database" in cells_description:
            return self.mock_buddy_data
        else:
            raise NotImplementedError("Mock not implemented for: %s" % cells_description)


    @patch.object(DatabaseConnector, '_get_cells')
    def test_get_buddy_email_pairs(self, mock_get_cells):
        mock_get_cells.side_effect = self._mocked_get_cells

        pairs = DatabaseConnector.get_instance().get_buddy_email_pairs()

        self.assertEqual(pairs, [
            ['email1@gmail.com', 'email2@gmail.com'],
            ['email1@gmail.com', 'email3@gmail.com']
        ])
    

    @patch.object(DatabaseConnector, '_get_cells')
    def test_get_all_buddies(self, mock_get_cells):
        mock_get_cells.side_effect = self._mocked_get_cells

        buddies = DatabaseConnector.get_instance().get_all_buddies()

        self.assertEqual(len(self.mock_buddy_data), len(buddies))

        for buddy_info, buddy in zip(self.mock_buddy_data, buddies):
            # NOTE: the .lower here is a side effect of creating a buddy
            self.assertEqual(buddy_info[0].lower(), buddy.email)
            self.assertEqual(buddy_info[1], buddy.pseudonym)
            self.assertEqual(buddy_info[2], buddy.phone)
            self.assertEqual(buddy_info[3], buddy.location)
            self.assertEqual(buddy_info[4], buddy.time_zone)
            self.assertEqual(buddy_info[5], buddy.user_message)
            self.assertEqual(buddy_info[6], buddy.full_name)
            self.assertEqual(buddy_info[7], buddy.buddy_type)


    @patch.object(DatabaseConnector, '_get_cells')
    def test_case_insensitive_emails(self, mock_get_cells):
        # change email1@gmail.com to uppercase in database
        self.mock_buddy_data[0][0] = self.mock_buddy_data[0][0].upper()

        # change one of the pairs to uppercase in matched list
        self.mock_match_data[0][0] = self.mock_match_data[0][0].upper()
        self.mock_match_data[0][1] = self.mock_match_data[0][1].upper()

        self.test_get_all_buddies()
        self.test_get_buddy_email_pairs()


if __name__ == '__main__':
    unittest.main()
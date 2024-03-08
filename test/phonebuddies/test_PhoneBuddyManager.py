from datetime import datetime
import itertools
from parameterized import parameterized
import unittest
from unittest.mock import patch, MagicMock
from phonebuddies.EmailDraft import EmailDraft
from phonebuddies.ResultTracker import ResultTracker
from phonebuddies.WeeklyProcess import WeeklyProcess
from phonebuddies.PhoneBuddyManager import PhoneBuddyManager, ADMIN_EMAILS
from phonebuddies.Buddy import Buddy
from phonebuddies.EmailInfo import EmailInfo

class TestPhoneBuddyManager(unittest.TestCase):


    def setUp(self):
        self.mock_buddy_map = {
            "email1@gmail.com": Buddy(["email1@gmail.com", "Pseudonym1", "Phone1", "City1", "Timezone1", "User Message1", "Full Name1", "English"]),
            "email2@gmail.com": Buddy(["email2@gmail.com", "Pseudonym2", "Phone2", "City2", "Timezone2", "User Message2", "Full Name2", "Afghan"]),
            "email3@gmail.com": Buddy(["email3@gmail.com", "Pseudonym3", "Phone3", "City3", "Timezone3", "User Message3", "Full Name3", "Afghan"])
        }

        self.mock_buddy_pairs = [
            ["email1@gmail.com", "email2@gmail.com"],
            ["email1@gmail.com", "email3@gmail.com"]
        ]

        self.mock_email_info = EmailInfo("Intro", "Topic")

        self.today_process_date = datetime.now().strftime("%A, %B %d, %Y")


    @staticmethod
    def nth_draft_sent(email_sender_instance, n):
        """
        Returns the nth draft email that was sent during testing
        """
        return email_sender_instance.send_email.call_args_list[n][0][0]


    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_send_buddy_emails_as_robot(self, mock_db_connector, mock_email_sender):
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_all_buddies_map.return_value = self.mock_buddy_map
        db_instance.get_email_info.return_value = self.mock_email_info

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.send_buddy_emails(self.mock_buddy_pairs)

        # Verify called the correct number of times
        self.assertEqual(email_sender_instance.send_email.call_count, len(self.mock_buddy_pairs))

        # Verify the drafts look good
        drafts_sent = [email_sender_instance.send_email.call_args_list[i][0][0] for i in range(len(self.mock_buddy_pairs))]
        for pair, draft in zip(self.mock_buddy_pairs, drafts_sent):
            first_buddy = self.mock_buddy_map[pair[0]]
            second_buddy = self.mock_buddy_map[pair[1]]

            # Verify subject looks good
            pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
            expected_subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms
            self.assertEqual(expected_subject, draft.subject)


    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_manage_phone_buddy_list_send_emails(self, mock_db_connector, mock_email_sender):
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_all_buddies_map.return_value = self.mock_buddy_map
        db_instance.get_buddy_email_pairs.return_value = self.mock_buddy_pairs
        db_instance.get_email_info.return_value = self.mock_email_info

        process_row_data = [self.today_process_date] + ["Yes", "Yes", "Yes", "Yes", "Yes", ""]
        weekly_process = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)
        db_instance.get_this_weeks_process.return_value = weekly_process

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)

        # XXX this is very naughty, but I want to test this and push without fixing #26
        manager._admin_emails.append("admin@gmail.com")

        manager.manage_phone_buddy_list()

        # Verify called the correct number of times, the result looks good
        # NOTE: sending 1 courtesy email to admin@gmail.com
        self.assertEqual(email_sender_instance.send_email.call_count, len(self.mock_buddy_pairs) + 1)
        self.assertEqual(ResultTracker.get_result(), "Phone buddy list sent")

        # Verify the drafts look good
        drafts_sent = [self.nth_draft_sent(email_sender_instance, i) for i in range(len(self.mock_buddy_pairs))]
        for pair, draft in zip(self.mock_buddy_pairs, drafts_sent):
            first_buddy = self.mock_buddy_map[pair[0]]
            second_buddy = self.mock_buddy_map[pair[1]]

            # Verify subject looks good
            pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
            expected_subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms
            self.assertEqual(expected_subject, draft.subject)

        # Verify the emails sent to admins were sent out after those
        expected_subject = EmailDraft.draft_admins_without_buddy_emails("a@example.com").subject
        draft = self.nth_draft_sent(email_sender_instance, len(self.mock_buddy_pairs))
        self.assertEqual(expected_subject, draft.subject)
        self.assertEqual("admin@gmail.com", draft.to)

        # XXX: remove hack from earlier related to #26
        manager._admin_emails = manager._admin_emails[:-1]


    # NOTE: the 3s here are totally useless and serve only to tell @parameterized that it should
    #       treat the following list as a single parameter and not as a list of parameters
    @parameterized.expand([
        (3, ["", "", "", "", "", ""]),
        (3, ["Yes", "", "", "", "", ""]),
        (3, ["Yes", "Yes", "", "", "", ""]),
        (3, ["Yes", "Yes", "Yes", "", "", ""])
    ])
    @patch('phonebuddies.PhoneBuddyManager.EmailSender')
    @patch('phonebuddies.PhoneBuddyManager.DatabaseConnector')
    def test_manage_phone_buddy_list_remind_admins(self, useless, process_entry_data, mock_db_connector, mock_email_sender):
        process_row_data = [self.today_process_date] + process_entry_data
        db_instance = mock_db_connector.get_instance.return_value
        db_instance.get_this_weeks_process.return_value = WeeklyProcess.parse_from_google_sheet_row(process_row_data, 0)

        email_sender_instance = mock_email_sender.get_instance.return_value

        # Set up the object and perform the test
        manager = PhoneBuddyManager(really_send_emails=False, is_robot=True)
        manager.manage_phone_buddy_list()

        # Verify that emails were sent to the two admins and that the result is correct
        self.assertEqual(email_sender_instance.send_email.call_count, 2)
        self.assertEqual(ResultTracker.get_result(), "Admins reminded")


if __name__ == '__main__':
    unittest.main()